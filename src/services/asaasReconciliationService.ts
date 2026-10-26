import { v4 as uuidv4 } from 'uuid';
import { getConnection, query } from '../db';
import { AsaasPayment, AsaasService, AsaasSubscription } from './asaasService';
import { ProvisioningService } from './provisioningService';

const PAID_STATUSES = new Set(['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH']);

function localInvoiceStatus(providerStatus = ''): string {
  if (PAID_STATUSES.has(providerStatus)) return 'PAID';
  if (providerStatus === 'OVERDUE') return 'OVERDUE';
  if (providerStatus.includes('CHARGEBACK')) return 'CHARGEBACK';
  if (providerStatus.includes('REFUND')) return 'REFUNDED';
  if (['DELETED', 'CANCELLED'].includes(providerStatus)) return 'CANCELLED';
  return 'PENDING';
}

function localSubscriptionStatus(providerStatus = ''): string {
  if (['ACTIVE', 'RECEIVED', 'CONFIRMED'].includes(providerStatus)) return 'ACTIVE';
  if (providerStatus === 'OVERDUE') return 'OVERDUE';
  if (['EXPIRED', 'INACTIVE'].includes(providerStatus)) return 'INACTIVE';
  if (['DELETED', 'CANCELLED'].includes(providerStatus)) return 'CANCELLED';
  return providerStatus || 'PENDING';
}

function proposalIdFromReference(reference?: string): string | null {
  if (!reference) return null;
  const match = /^faithhub:proposal:([0-9a-f-]{36})$/i.exec(reference);
  return match?.[1] || null;
}

async function resolveProposal(payment?: AsaasPayment, subscription?: AsaasSubscription) {
  const referencedId = proposalIdFromReference(payment?.externalReference || subscription?.externalReference);
  if (referencedId) {
    const { rows } = await query('SELECT * FROM saas_proposals WHERE id = ? LIMIT 1', [referencedId]);
    return rows[0] || null;
  }
  const subscriptionId = payment?.subscription || subscription?.id;
  if (!subscriptionId) return null;
  const { rows } = await query(
    'SELECT * FROM saas_proposals WHERE asaas_subscription_id = ? LIMIT 1',
    [subscriptionId]
  );
  return rows[0] || null;
}

async function reconcilePayment(eventRow: any): Promise<void> {
  if (!eventRow.payment_id) throw new Error('ASAAS_EVENT_PAYMENT_ID_REQUIRED');
  if (eventRow.event_type === 'PAYMENT_DELETED') {
    await query(`UPDATE saas_invoices SET status = 'CANCELLED', provider_status = 'DELETED',
      last_event_id = ?, updated_at = NOW() WHERE asaas_payment_id = ?`, [eventRow.id, eventRow.payment_id]);
    return;
  }
  const payment = await AsaasService.getPayment(eventRow.payment_id);
  let subscription: AsaasSubscription | undefined;
  if (payment.subscription) subscription = await AsaasService.getSubscription(payment.subscription);
  const proposal = await resolveProposal(payment, subscription);
  if (!proposal) throw new Error('ASAAS_PROPOSAL_NOT_FOUND_BY_PROVIDER_REFERENCE');

  const organizationId = proposal.created_organization_id || null;
  const externalReference = payment.externalReference || subscription?.externalReference || proposal.billing_external_reference;
  const providerStatus = payment.status || 'UNKNOWN';
  const invoiceStatus = localInvoiceStatus(providerStatus);
  const paidAt = PAID_STATUSES.has(providerStatus)
    ? (payment.paymentDate || payment.clientPaymentDate || new Date().toISOString().slice(0, 19).replace('T', ' '))
    : null;
  const connection = await getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`INSERT INTO saas_invoices
      (id, subscription_id, organization_id, plan_id, amount, due_date, paid_at, status,
       payment_method, payment_link, asaas_payment_id, external_reference, provider_status,
       billing_type, invoice_url, bank_slip_url, last_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        subscription_id = VALUES(subscription_id),
        organization_id = COALESCE(VALUES(organization_id), organization_id),
        amount = VALUES(amount), due_date = VALUES(due_date), paid_at = VALUES(paid_at),
        status = VALUES(status), payment_method = VALUES(payment_method),
        payment_link = VALUES(payment_link), external_reference = VALUES(external_reference),
        provider_status = VALUES(provider_status), billing_type = VALUES(billing_type),
        invoice_url = VALUES(invoice_url), bank_slip_url = VALUES(bank_slip_url),
        last_event_id = VALUES(last_event_id), updated_at = NOW()`, [
      uuidv4(), payment.subscription || 'NO_SUBSCRIPTION', organizationId,
      proposal.plan_tier || 'PRO', Number(payment.value || proposal.monthly_amount || 0),
      payment.dueDate || new Date().toISOString().slice(0, 10), paidAt, invoiceStatus,
      payment.billingType || 'UNKNOWN', payment.invoiceUrl || null, payment.id,
      externalReference || null, providerStatus, payment.billingType || null,
      payment.invoiceUrl || null, payment.bankSlipUrl || null, eventRow.id
    ]);

    if (subscription) {
      await connection.query(`INSERT INTO saas_subscriptions
        (id, organization_id, customer_id, proposal_id, church_name, status, value, cycle,
         billing_type, next_due_date, payment_link, external_reference, provider_status,
         last_payment_id, last_event_id, is_verified, verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())
        ON DUPLICATE KEY UPDATE
          organization_id = COALESCE(VALUES(organization_id), organization_id),
          customer_id = VALUES(customer_id), proposal_id = VALUES(proposal_id),
          status = VALUES(status), value = VALUES(value), cycle = VALUES(cycle),
          billing_type = VALUES(billing_type), next_due_date = VALUES(next_due_date),
          external_reference = VALUES(external_reference), provider_status = VALUES(provider_status),
          last_payment_id = VALUES(last_payment_id), last_event_id = VALUES(last_event_id),
          is_verified = 1, verified_at = NOW(), updated_at = NOW()`, [
        subscription.id, organizationId, subscription.customer || payment.customer || null,
        proposal.id, proposal.church_name, localSubscriptionStatus(subscription.status || providerStatus),
        Number(subscription.value || payment.value || proposal.monthly_amount || 0),
        subscription.cycle || proposal.billing_cycle || 'MONTHLY',
        subscription.billingType || payment.billingType || 'UNKNOWN',
        subscription.nextDueDate || payment.dueDate || null, payment.invoiceUrl || null,
        externalReference || null, subscription.status || providerStatus,
        payment.id, eventRow.id
      ]);
    }

    await connection.query(`UPDATE saas_proposals SET
      asaas_customer_id = COALESCE(?, asaas_customer_id),
      asaas_subscription_id = COALESCE(?, asaas_subscription_id),
      billing_status = ?, billing_error = NULL, updated_at = NOW()
      WHERE id = ?`, [
      payment.customer || subscription?.customer || null,
      payment.subscription || subscription?.id || null,
      invoiceStatus,
      proposal.id
    ]);

    if (PAID_STATUSES.has(providerStatus)) {
      await connection.query(`INSERT INTO saas_provisioning_jobs
        (id, proposal_id, source_event_id, organization_id, status)
        VALUES (?, ?, ?, ?, 'PENDING')
        ON DUPLICATE KEY UPDATE updated_at = NOW()`, [
        `prov_${eventRow.id}`.slice(0, 100), proposal.id, eventRow.id, organizationId
      ]);
    }

    await connection.query(`INSERT INTO security_audit_logs
      (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
      VALUES (?, ?, NULL, 'asaas-webhook@faithhubs.com', 'SYSTEM', ?, 'saas_invoices', ?, ?, 'SUCCESS')`, [
      uuidv4(), organizationId || 'org_default', `ASAAS_${eventRow.event_type}`, payment.id,
      JSON.stringify({ providerStatus, invoiceStatus, subscriptionId: payment.subscription || null, eventId: eventRow.id })
    ]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  if (PAID_STATUSES.has(providerStatus)) {
    await query(`UPDATE saas_provisioning_jobs SET status = 'PROCESSING', attempts = attempts + 1, updated_at = NOW()
      WHERE source_event_id = ? AND status != 'COMPLETED'`, [eventRow.id]);
    try {
      const result = await ProvisioningService.provisionFromProposal(proposal.id);
      await query(`UPDATE saas_provisioning_jobs SET status = 'COMPLETED', organization_id = ?,
        completed_at = NOW(), last_error = NULL, updated_at = NOW() WHERE source_event_id = ?`, [
        result.organization_id, eventRow.id
      ]);
      await query(`UPDATE saas_invoices SET organization_id = ? WHERE asaas_payment_id = ?`, [
        result.organization_id, payment.id
      ]);
    } catch (error: any) {
      await query(`UPDATE saas_provisioning_jobs SET status = 'FAILED', last_error = ?, updated_at = NOW()
        WHERE source_event_id = ?`, [String(error?.message || 'PROVISIONING_FAILED').slice(0, 500), eventRow.id]);
      throw error;
    }
  }
}

async function reconcileSubscription(eventRow: any): Promise<void> {
  if (!eventRow.subscription_id) throw new Error('ASAAS_EVENT_SUBSCRIPTION_ID_REQUIRED');
  if (eventRow.event_type === 'SUBSCRIPTION_DELETED') {
    await query(`UPDATE saas_subscriptions SET status = 'CANCELLED', provider_status = 'DELETED',
      last_event_id = ?, updated_at = NOW() WHERE id = ?`, [eventRow.id, eventRow.subscription_id]);
    await query(`UPDATE saas_proposals SET billing_status = 'CANCELLED', updated_at = NOW()
      WHERE asaas_subscription_id = ?`, [eventRow.subscription_id]);
    return;
  }
  const subscription = await AsaasService.getSubscription(eventRow.subscription_id);
  const proposal = await resolveProposal(undefined, subscription);
  if (!proposal) throw new Error('ASAAS_PROPOSAL_NOT_FOUND_BY_PROVIDER_REFERENCE');
  const organizationId = proposal.created_organization_id || null;
  await query(`INSERT INTO saas_subscriptions
    (id, organization_id, customer_id, proposal_id, church_name, status, value, cycle,
     billing_type, next_due_date, external_reference, provider_status, last_event_id, is_verified, verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())
    ON DUPLICATE KEY UPDATE
      organization_id = COALESCE(VALUES(organization_id), organization_id), customer_id = VALUES(customer_id),
      proposal_id = VALUES(proposal_id), status = VALUES(status), value = VALUES(value),
      cycle = VALUES(cycle), billing_type = VALUES(billing_type), next_due_date = VALUES(next_due_date),
      external_reference = VALUES(external_reference), provider_status = VALUES(provider_status),
      last_event_id = VALUES(last_event_id), is_verified = 1, verified_at = NOW(), updated_at = NOW()`, [
    subscription.id, organizationId, subscription.customer || null, proposal.id, proposal.church_name,
    localSubscriptionStatus(subscription.status), Number(subscription.value || proposal.monthly_amount || 0),
    subscription.cycle || proposal.billing_cycle || 'MONTHLY', subscription.billingType || 'UNKNOWN',
    subscription.nextDueDate || null, subscription.externalReference || proposal.billing_external_reference,
    subscription.status || 'UNKNOWN', eventRow.id
  ]);
  await query(`UPDATE saas_proposals SET asaas_customer_id = COALESCE(?, asaas_customer_id),
    asaas_subscription_id = ?, billing_status = ?, billing_error = NULL, updated_at = NOW() WHERE id = ?`, [
    subscription.customer || null, subscription.id, localSubscriptionStatus(subscription.status), proposal.id
  ]);
}

export async function processAsaasEvent(eventId: string): Promise<void> {
  const { rows } = await query('SELECT * FROM asaas_webhook_events WHERE id = ? LIMIT 1', [eventId]);
  if (!rows.length) throw new Error('ASAAS_EVENT_NOT_FOUND');
  const eventRow = rows[0];
  if (eventRow.status === 'PROCESSED') return;
  await query(`UPDATE asaas_webhook_events SET status = 'PROCESSING', attempts = attempts + 1,
    last_error = NULL, updated_at = NOW() WHERE id = ?`, [eventId]);
  try {
    if (eventRow.event_type.startsWith('PAYMENT_')) await reconcilePayment(eventRow);
    else if (eventRow.event_type.startsWith('SUBSCRIPTION_')) await reconcileSubscription(eventRow);
    else if (eventRow.event_type.startsWith('CHECKOUT_') && eventRow.checkout_id) {
      const status = eventRow.event_type.replace('CHECKOUT_', '');
      await query(`UPDATE saas_proposals SET billing_status = ?, updated_at = NOW()
        WHERE asaas_checkout_id = ?`, [status, eventRow.checkout_id]);
    }
    await query(`UPDATE asaas_webhook_events SET status = 'PROCESSED', processed_at = NOW(),
      last_error = NULL, updated_at = NOW() WHERE id = ?`, [eventId]);
  } catch (error: any) {
    await query(`UPDATE asaas_webhook_events SET status = 'FAILED', last_error = ?, updated_at = NOW()
      WHERE id = ?`, [String(error?.message || 'PROCESSING_FAILED').slice(0, 500), eventId]);
    throw error;
  }
}
