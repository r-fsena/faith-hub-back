import type { PoolConnection } from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';
import {costGate,quantityUnits,manualCost,saleCost,costHash} from './pdvCosts';

export class InventoryError extends Error {
  constructor(public code: string, message: string, public statusCode = 409) {
    super(message);
  }
}

export type InventoryOrderItem = {
  productId: string;
  quantity: number;
  trackInventory: boolean;
};

type Balance = {
  id: string;
  on_hand_quantity: number | string;
  reserved_quantity: number | string;
  minimum_stock: number | string;
  allow_negative: number;
};

const numberValue = (value: unknown): number => Number(value) || 0;

async function lockBalance(
  connection: PoolConnection,
  organizationId: string,
  campusId: string,
  productId: string
): Promise<Balance> {
  await connection.query(
    `INSERT IGNORE INTO pdv_inventory_balances
      (id, organization_id, campus_id, product_id, on_hand_quantity, reserved_quantity, minimum_stock)
     VALUES (?, ?, ?, ?, 0, 0, 0)`,
    [uuidv4(), organizationId, campusId, productId]
  );
  const [rows] = await connection.query(
    `SELECT id, on_hand_quantity, reserved_quantity, minimum_stock, allow_negative
       FROM pdv_inventory_balances
      WHERE organization_id = ? AND campus_id = ? AND product_id = ?
      FOR UPDATE`,
    [organizationId, campusId, productId]
  );
  const balance = (rows as Balance[])[0];
  if (!balance) throw new InventoryError('INVENTORY_BALANCE_NOT_FOUND', 'Não foi possível preparar o saldo do produto.', 500);
  return balance;
}

async function insertMovement(
  connection: PoolConnection,
  values: {
    organizationId: string;
    campusId: string;
    productId: string;
    movementType: string;
    quantityDelta: number;
    reservedDelta: number;
    previousOnHand: number;
    newOnHand: number;
    previousReserved: number;
    newReserved: number;
    reason: string;
    notes?: string | null;
    referenceType?: string | null;
    referenceId?: string | null;
    idempotencyKey: string;
    createdBy?: string | null;
  }
): Promise<void> {
  await connection.query(
    `INSERT IGNORE INTO pdv_inventory_movements
      (id, organization_id, campus_id, product_id, movement_type, quantity_delta, reserved_delta,
       previous_on_hand, new_on_hand, previous_reserved, new_reserved, reason, notes,
       reference_type, reference_id, idempotency_key, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(), values.organizationId, values.campusId, values.productId, values.movementType,
      values.quantityDelta, values.reservedDelta, values.previousOnHand, values.newOnHand,
      values.previousReserved, values.newReserved, values.reason, values.notes || null,
      values.referenceType || null, values.referenceId || null, values.idempotencyKey,
      values.createdBy || null
    ]
  );
}

export async function reserveOrderInventory(
  connection: PoolConnection,
  input: {
    organizationId: string;
    campusId: string;
    orderId: string;
    items: InventoryOrderItem[];
    actorId?: string | null;
    expiresAt: Date;
  }
): Promise<void> {
  for (const item of input.items.filter(current => current.trackInventory)) {
    const balance = await lockBalance(connection, input.organizationId, input.campusId, item.productId);
    const onHand = numberValue(balance.on_hand_quantity);
    const reserved = numberValue(balance.reserved_quantity);
    const available = onHand - reserved;
    const minimumStock = numberValue(balance.minimum_stock);
    const sellableQuantity = Math.max(0, available - minimumStock);
    // Pedidos nunca podem consumir o estoque de segurança. A opção allow_negative
    // continua válida para ajustes administrativos, mas não para vendas.
    if (sellableQuantity < item.quantity) {
      throw new InventoryError(
        'INSUFFICIENT_STOCK',
        minimumStock > 0
          ? `Estoque mínimo atingido. Disponível para venda: ${sellableQuantity}.`
          : `Estoque insuficiente para concluir o pedido. Disponível: ${available}.`
      );
    }
    const nextReserved = reserved + item.quantity;
    await connection.query(
      `UPDATE pdv_inventory_balances
          SET reserved_quantity = ?, updated_at = NOW()
        WHERE id = ? AND organization_id = ? AND campus_id = ?`,
      [nextReserved, balance.id, input.organizationId, input.campusId]
    );
    await connection.query(
      `INSERT INTO pdv_inventory_reservations
        (id, organization_id, campus_id, order_id, product_id, quantity, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      [uuidv4(), input.organizationId, input.campusId, input.orderId, item.productId, item.quantity, input.expiresAt]
    );
    await insertMovement(connection, {
      organizationId: input.organizationId,
      campusId: input.campusId,
      productId: item.productId,
      movementType: 'RESERVATION',
      quantityDelta: 0,
      reservedDelta: item.quantity,
      previousOnHand: onHand,
      newOnHand: onHand,
      previousReserved: reserved,
      newReserved: nextReserved,
      reason: 'Reserva automática do pedido',
      referenceType: 'PDV_ORDER',
      referenceId: input.orderId,
      idempotencyKey: `reservation:${input.orderId}:${item.productId}`,
      createdBy: input.actorId
    });
  }
}

export async function transitionOrderInventory(
  connection: PoolConnection,
  input: {
    organizationId: string;
    orderId: string;
    transition: 'COMMIT' | 'CANCEL';
    actorId?: string | null;
    reason?: string;
  }
): Promise<{ affected: number; action: 'COMMITTED' | 'RELEASED' | 'REVERSED' | 'NONE' }> {
  const [reservationRows] = await connection.query(
    `SELECT id, campus_id, product_id, quantity, status
       FROM pdv_inventory_reservations
      WHERE organization_id = ? AND order_id = ?
      ORDER BY product_id
      FOR UPDATE`,
    [input.organizationId, input.orderId]
  );
  const reservations = reservationRows as Array<{ id: string; campus_id: string; product_id: string; quantity: number | string; status: string }>;
  let affected = 0;
  let action: 'COMMITTED' | 'RELEASED' | 'REVERSED' | 'NONE' = 'NONE';

  for (const reservation of reservations) {
    const quantity = numberValue(reservation.quantity);
    const balance = await lockBalance(connection, input.organizationId, reservation.campus_id, reservation.product_id);
    const onHand = numberValue(balance.on_hand_quantity);
    const reserved = numberValue(balance.reserved_quantity);

    if (input.transition === 'COMMIT') {
      if (reservation.status === 'COMMITTED') continue;
      if (reservation.status !== 'ACTIVE') {
        throw new InventoryError('RESERVATION_NOT_ACTIVE', 'A reserva deste pedido não está mais ativa. Revise o pedido antes de confirmar o pagamento.');
      }
      if (!balance.allow_negative && onHand < quantity) {
        throw new InventoryError('INSUFFICIENT_STOCK', 'O saldo físico mudou e não é suficiente para confirmar esta venda.');
      }
      await saleCost(connection,input,reservation,onHand,'COMMIT',await costGate(input.organizationId,reservation.campus_id));
      const nextOnHand = onHand - quantity;
      const nextReserved = Math.max(0, reserved - quantity);
      await connection.query(
        `UPDATE pdv_inventory_balances SET on_hand_quantity = ?, reserved_quantity = ?, updated_at = NOW()
          WHERE id = ? AND organization_id = ? AND campus_id = ?`,
        [nextOnHand, nextReserved, balance.id, input.organizationId, reservation.campus_id]
      );
      await connection.query(
        `UPDATE pdv_inventory_reservations SET status = 'COMMITTED', committed_at = NOW(), updated_at = NOW()
          WHERE id = ? AND organization_id = ?`,
        [reservation.id, input.organizationId]
      );
      await insertMovement(connection, {
        organizationId: input.organizationId,
        campusId: reservation.campus_id,
        productId: reservation.product_id,
        movementType: 'SALE',
        quantityDelta: -quantity,
        reservedDelta: -quantity,
        previousOnHand: onHand,
        newOnHand: nextOnHand,
        previousReserved: reserved,
        newReserved: nextReserved,
        reason: input.reason || 'Baixa automática por pagamento confirmado',
        referenceType: 'PDV_ORDER',
        referenceId: input.orderId,
        idempotencyKey: `sale:${input.orderId}:${reservation.product_id}`,
        createdBy: input.actorId
      });
      action = 'COMMITTED';
      affected++;
      continue;
    }

    if (reservation.status === 'ACTIVE') {
      const nextReserved = Math.max(0, reserved - quantity);
      await connection.query(
        `UPDATE pdv_inventory_balances SET reserved_quantity = ?, updated_at = NOW()
          WHERE id = ? AND organization_id = ? AND campus_id = ?`,
        [nextReserved, balance.id, input.organizationId, reservation.campus_id]
      );
      await connection.query(
        `UPDATE pdv_inventory_reservations SET status = 'RELEASED', released_at = NOW(), updated_at = NOW()
          WHERE id = ? AND organization_id = ?`,
        [reservation.id, input.organizationId]
      );
      await insertMovement(connection, {
        organizationId: input.organizationId,
        campusId: reservation.campus_id,
        productId: reservation.product_id,
        movementType: 'RESERVATION_RELEASE',
        quantityDelta: 0,
        reservedDelta: -quantity,
        previousOnHand: onHand,
        newOnHand: onHand,
        previousReserved: reserved,
        newReserved: nextReserved,
        reason: input.reason || 'Reserva liberada pelo cancelamento do pedido',
        referenceType: 'PDV_ORDER',
        referenceId: input.orderId,
        idempotencyKey: `release:${input.orderId}:${reservation.product_id}`,
        createdBy: input.actorId
      });
      action = 'RELEASED';
      affected++;
    } else if (reservation.status === 'COMMITTED') {
      await saleCost(connection,input,reservation,onHand,'CANCEL',await costGate(input.organizationId,reservation.campus_id));
      const nextOnHand = onHand + quantity;
      await connection.query(
        `UPDATE pdv_inventory_balances SET on_hand_quantity = ?, updated_at = NOW()
          WHERE id = ? AND organization_id = ? AND campus_id = ?`,
        [nextOnHand, balance.id, input.organizationId, reservation.campus_id]
      );
      await connection.query(
        `UPDATE pdv_inventory_reservations SET status = 'REVERSED', released_at = NOW(), updated_at = NOW()
          WHERE id = ? AND organization_id = ?`,
        [reservation.id, input.organizationId]
      );
      await insertMovement(connection, {
        organizationId: input.organizationId,
        campusId: reservation.campus_id,
        productId: reservation.product_id,
        movementType: 'SALE_REVERSAL',
        quantityDelta: quantity,
        reservedDelta: 0,
        previousOnHand: onHand,
        newOnHand: nextOnHand,
        previousReserved: reserved,
        newReserved: reserved,
        reason: input.reason || 'Estorno automático pelo cancelamento do pedido',
        referenceType: 'PDV_ORDER',
        referenceId: input.orderId,
        idempotencyKey: `reversal:${input.orderId}:${reservation.product_id}`,
        createdBy: input.actorId
      });
      action = 'REVERSED';
      affected++;
    }
  }
  return { affected, action };
}

export async function applyManualInventoryMovement(
  connection: PoolConnection,
  input: {
    organizationId: string;
    campusId: string;
    productId: string;
    type: 'ENTRY' | 'EXIT' | 'ADJUSTMENT' | 'LOSS' | 'OPENING_BALANCE';
    quantity: number;
    reason: string;
    notes?: string | null;
    actorId: string;
    requestId?: string; totalCostCents?:number|null; additionalCostCents?:number; sourceReference?:string;
  }
): Promise<{ previousOnHand: number; newOnHand: number }> {
  quantityUnits(input.quantity);
  const balance = await lockBalance(connection, input.organizationId, input.campusId, input.productId);
  const onHand = numberValue(balance.on_hand_quantity);
  const reserved = numberValue(balance.reserved_quantity);
  const enabled=await costGate(input.organizationId,input.campusId);
  if((enabled||input.requestId!==undefined)&&(typeof input.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.requestId)))throw new InventoryError('REQUEST_ID_REQUIRED','Atualize o Studio para enviar uma referência única da movimentação.',400);
  if(input.requestId){const [existing]:any=await connection.query('SELECT request_hash,result_json FROM pdv_cost_events WHERE organization_id = ? AND id = ?',[input.organizationId,'manual:'+input.requestId]);if(existing.length){if(existing[0].request_hash!==costHash(input))throw new InventoryError('REQUEST_REUSED','Referência já usada com outros dados. Atualize o estoque.',409);return typeof existing[0].result_json==='string'?JSON.parse(existing[0].result_json):existing[0].result_json;}}
  if(input.requestId){const [old]:any=await connection.query('SELECT * FROM pdv_inventory_movements WHERE organization_id = ? AND idempotency_key = ?',[input.organizationId,'manual:'+input.requestId]);if(old.length){const r=old[0],requested=['ADJUSTMENT','OPENING_BALANCE'].includes(input.type)?Number(r.new_on_hand):Math.abs(Number(r.quantity_delta));if(r.campus_id!==input.campusId||r.product_id!==input.productId||r.movement_type!==input.type||requested!==input.quantity||r.reason!==input.reason||(r.notes||null)!==(input.notes||null)||r.created_by!==input.actorId||input.totalCostCents!=null||input.additionalCostCents)throw new InventoryError('REQUEST_REUSED','Referência já usada. Atualize o estoque.',409);return{previousOnHand:Number(r.previous_on_hand),newOnHand:Number(r.new_on_hand)};}}
  let delta = 0;
  if (input.type === 'ENTRY') delta = input.quantity;
  if (input.type === 'EXIT' || input.type === 'LOSS') delta = -input.quantity;
  if (input.type === 'ADJUSTMENT' || input.type === 'OPENING_BALANCE') delta = input.quantity - onHand;
  const nextOnHand = Math.round((onHand + delta)*1000)/1000;
  if (!balance.allow_negative && nextOnHand < reserved) {
    throw new InventoryError('INSUFFICIENT_AVAILABLE_STOCK', `O ajuste não pode deixar o saldo físico abaixo das ${reserved} unidades reservadas.`);
  }
  await connection.query(
    `UPDATE pdv_inventory_balances SET on_hand_quantity = ?, updated_at = NOW()
      WHERE id = ? AND organization_id = ? AND campus_id = ?`,
    [nextOnHand, balance.id, input.organizationId, input.campusId]
  );
  const movementId = input.requestId||uuidv4();
  await manualCost(connection,input,onHand,nextOnHand,movementId,enabled);
  await insertMovement(connection, {
    organizationId: input.organizationId,
    campusId: input.campusId,
    productId: input.productId,
    movementType: input.type,
    quantityDelta: delta,
    reservedDelta: 0,
    previousOnHand: onHand,
    newOnHand: nextOnHand,
    previousReserved: reserved,
    newReserved: reserved,
    reason: input.reason,
    notes: input.notes,
    referenceType: 'MANUAL',
    referenceId: movementId,
    idempotencyKey: `manual:${movementId}`,
    createdBy: input.actorId
  });
  return { previousOnHand: onHand, newOnHand: nextOnHand };
}
