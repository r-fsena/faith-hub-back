const tables=[
`CREATE TABLE IF NOT EXISTS intelligence_capacity_rollout (organization_id VARCHAR(100) NOT NULL,campus_id VARCHAR(100) NOT NULL,activated_at DATETIME(6) NOT NULL,PRIMARY KEY(organization_id,campus_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS intelligence_capacity_bindings (
 organization_id VARCHAR(100) NOT NULL,source_kind VARCHAR(20) NOT NULL,source_id VARCHAR(100) NOT NULL,campus_id VARCHAR(100) NOT NULL,
 revision_id CHAR(36) NULL,version INT NOT NULL DEFAULT -1,updated_at DATETIME(6) NOT NULL,
 PRIMARY KEY(organization_id,source_kind,source_id),KEY idx_capacity_binding_scope(organization_id,campus_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS intelligence_capacity_revisions (
 organization_id VARCHAR(100) NOT NULL,id CHAR(36) NOT NULL,campus_id VARCHAR(100) NOT NULL,source_kind VARCHAR(20) NOT NULL,source_id VARCHAR(100) NOT NULL,
 version INT NOT NULL,snapshot_json JSON NOT NULL,reason VARCHAR(240) NOT NULL,actor_id VARCHAR(100) NULL,recorded_at DATETIME(6) NOT NULL,
 PRIMARY KEY(organization_id,id),UNIQUE KEY uq_capacity_revision(organization_id,source_kind,source_id,version),KEY idx_capacity_asof(organization_id,source_kind,source_id,recorded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS intelligence_kids_sessions (
 organization_id VARCHAR(100) NOT NULL,id CHAR(36) NOT NULL,campus_id VARCHAR(100) NOT NULL,room_id VARCHAR(100) NOT NULL,title VARCHAR(120) NOT NULL,
 status VARCHAR(12) NOT NULL DEFAULT 'OPEN',occupied INT NOT NULL DEFAULT 0,capacity_revision_id CHAR(36) NOT NULL,version INT NOT NULL DEFAULT 0,
 active_room_id VARCHAR(100) GENERATED ALWAYS AS (CASE WHEN status='OPEN' THEN room_id ELSE NULL END) STORED,
 request_hash CHAR(64) NOT NULL,opened_by VARCHAR(100) NOT NULL,opened_at DATETIME(6) NOT NULL,closed_at DATETIME(6) NULL,
 PRIMARY KEY(organization_id,id),UNIQUE KEY uq_kids_open_session(organization_id,active_room_id),KEY idx_kids_session_scope(organization_id,campus_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];
const columns={event_lots:{organization_id:'VARCHAR(100) NULL'},event_tickets:{capacity_revision_id:'CHAR(36) NULL'},kids_checkins:{session_id:'CHAR(36) NULL',capacity_revision_id:'CHAR(36) NULL'}};
function flag(org,campus){return `COALESCE((SELECT f.is_enabled FROM tenant_feature_flags f WHERE f.feature_key='intelligence.capacities' AND f.organization_id IN ('global',${org}) AND f.environment IN ('all','production') AND (f.campus_id IS NULL OR f.campus_id=${campus}) ORDER BY (f.organization_id=${org}) DESC,(f.campus_id IS NOT NULL) DESC,(f.environment='production') DESC LIMIT 1),0)=1`;}
function observed(org,kind,source){return `EXISTS(SELECT 1 FROM intelligence_capacity_bindings b WHERE b.organization_id=${org} AND b.source_kind='${kind}' AND b.source_id=${source})`;}
function capture(org,campus,kind,source,payload){return `
 INSERT IGNORE INTO intelligence_capacity_bindings(organization_id,source_kind,source_id,campus_id,updated_at) VALUES(${org},'${kind}',${source},${campus},UTC_TIMESTAMP(6));
 SELECT version+1 INTO v_version FROM intelligence_capacity_bindings WHERE organization_id=${org} AND source_kind='${kind}' AND source_id=${source} FOR UPDATE;
 SET v_revision=UUID();
 INSERT INTO intelligence_capacity_revisions(organization_id,id,campus_id,source_kind,source_id,version,snapshot_json,reason,recorded_at)
 VALUES(${org},v_revision,${campus},'${kind}',${source},v_version,${payload},'Referência capturada na operação de origem',UTC_TIMESTAMP(6));
 UPDATE intelligence_capacity_bindings SET revision_id=v_revision,version=v_version,campus_id=${campus},updated_at=UTC_TIMESTAMP(6) WHERE organization_id=${org} AND source_kind='${kind}' AND source_id=${source};
 INSERT IGNORE INTO intelligence_capacity_rollout(organization_id,campus_id,activated_at) VALUES(${org},${campus},UTC_TIMESTAMP(6));`;}
const schedulePayload=`JSON_OBJECT('roles',COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('role_id',r.id,'role_name',r.name,'minimum',GREATEST(COALESCE(r.min_volunteers,0),0))) FROM ministry_roles r WHERE r.organization_id=NEW.organization_id AND r.ministry_id=NEW.ministry_id),JSON_ARRAY()),'title',NEW.title,'ministry_id',NEW.ministry_id,'service_date',DATE_FORMAT(NEW.service_date,'%Y-%m-%d'),'service_time',NEW.service_time)`;
const triggers=[];
for(const mode of ['INSERT','UPDATE'])triggers.push(`CREATE TRIGGER fh_capacity_schedule_${mode.toLowerCase()} AFTER ${mode} ON service_schedules FOR EACH ROW BEGIN
 DECLARE v_revision CHAR(36);DECLARE v_version INT;
 IF NEW.status IN ('PUBLISHED','COMPLETED') ${mode==='UPDATE'?"AND (OLD.status NOT IN ('PUBLISHED','COMPLETED') OR NOT(OLD.service_date <=> NEW.service_date) OR NOT(OLD.service_time <=> NEW.service_time))":''} AND (${flag('NEW.organization_id',"COALESCE(NEW.campus_id,'campus_sede')")} OR ${observed('NEW.organization_id','SCHEDULE','NEW.id')}) THEN ${capture('NEW.organization_id',"COALESCE(NEW.campus_id,'campus_sede')",'SCHEDULE','NEW.id',schedulePayload)} END IF; END`);
for(const mode of ['INSERT','UPDATE'])triggers.push(`CREATE TRIGGER fh_capacity_lot_tenant_${mode.toLowerCase()} BEFORE ${mode} ON event_lots FOR EACH ROW BEGIN
 DECLARE v_org VARCHAR(100);
 SELECT organization_id INTO v_org FROM events WHERE id=NEW.event_id;
 IF v_org IS NULL OR (NEW.organization_id IS NOT NULL AND NEW.organization_id<>v_org) ${mode==='UPDATE'?'OR (OLD.organization_id IS NOT NULL AND OLD.organization_id<>v_org)':''} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='CAPACITY_EVENT_TENANT_CONFLICT'; END IF;
 SET NEW.organization_id=v_org; END`);
for(const mode of ['INSERT','UPDATE'])triggers.push(`CREATE TRIGGER fh_capacity_lot_${mode.toLowerCase()} AFTER ${mode} ON event_lots FOR EACH ROW BEGIN
 DECLARE v_campus VARCHAR(100);DECLARE v_revision CHAR(36);DECLARE v_version INT;
 SELECT COALESCE(campus_id,'campus_sede') INTO v_campus FROM events WHERE organization_id=NEW.organization_id AND id=NEW.event_id;
 IF ${mode==='UPDATE'?'NOT(OLD.total_capacity <=> NEW.total_capacity) AND ':''}(${flag('NEW.organization_id','v_campus')} OR ${observed('NEW.organization_id','EVENT_LOT','NEW.id')}) THEN ${capture('NEW.organization_id','v_campus','EVENT_LOT','NEW.id',"JSON_OBJECT('event_id',NEW.event_id,'capacity',NEW.total_capacity)")} END IF; END`);
triggers.push(`CREATE TRIGGER fh_capacity_ticket_insert BEFORE INSERT ON event_tickets FOR EACH ROW BEGIN
 DECLARE v_capacity INT;DECLARE v_campus VARCHAR(100);DECLARE v_revision CHAR(36);DECLARE v_version INT;DECLARE v_exists INT DEFAULT 0;
 IF NEW.lot_id IS NOT NULL THEN
 SELECT COALESCE(e.campus_id,'campus_sede'),l.total_capacity INTO v_campus,v_capacity FROM event_lots l INNER JOIN events e ON e.id=l.event_id AND e.organization_id=NEW.organization_id WHERE l.organization_id=NEW.organization_id AND l.id=NEW.lot_id AND l.event_id=NEW.event_id;
 IF v_campus IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='CAPACITY_EVENT_TENANT_CONFLICT'; END IF;
 IF (${flag('NEW.organization_id','v_campus')} OR ${observed('NEW.organization_id','EVENT_LOT','NEW.lot_id')}) THEN
 SELECT COUNT(*) INTO v_exists FROM intelligence_capacity_bindings WHERE organization_id=NEW.organization_id AND source_kind='EVENT_LOT' AND source_id=NEW.lot_id;
 IF v_exists=0 THEN ${capture('NEW.organization_id','v_campus','EVENT_LOT','NEW.lot_id',"JSON_OBJECT('event_id',NEW.event_id,'capacity',v_capacity)")} END IF;
 SELECT revision_id INTO NEW.capacity_revision_id FROM intelligence_capacity_bindings WHERE organization_id=NEW.organization_id AND source_kind='EVENT_LOT' AND source_id=NEW.lot_id;
 END IF;END IF;END`);
// Use an atomic counter on a different table: concurrent inserts cannot read a stale occupancy snapshot.
triggers.push(`CREATE TRIGGER fh_capacity_kids_insert BEFORE INSERT ON kids_checkins FOR EACH ROW BEGIN
 DECLARE v_session CHAR(36);DECLARE v_revision CHAR(36);DECLARE v_campus VARCHAR(100);
 DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_session=NULL;
 SET v_campus=COALESCE(NEW.campus_id,'campus_sede');
 IF NEW.status IN ('CHECKED_IN','CALLING_PARENTS') AND (${flag('NEW.organization_id','v_campus')} OR EXISTS(SELECT 1 FROM intelligence_kids_sessions s WHERE s.organization_id=NEW.organization_id AND s.campus_id=v_campus AND s.room_id=NEW.room_id AND s.status='OPEN')) THEN
 SELECT s.id,s.capacity_revision_id INTO v_session,v_revision FROM intelligence_kids_sessions s WHERE s.organization_id=NEW.organization_id AND s.campus_id=v_campus AND s.room_id=NEW.room_id AND s.status='OPEN' FOR UPDATE;
 IF v_session IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='KIDS_SESSION_REQUIRED'; END IF;
 UPDATE intelligence_kids_sessions s INNER JOIN intelligence_capacity_revisions r ON r.organization_id=s.organization_id AND r.id=s.capacity_revision_id
 SET s.occupied=s.occupied+1 WHERE s.organization_id=NEW.organization_id AND s.id=v_session AND s.status='OPEN' AND s.occupied<CAST(JSON_UNQUOTE(JSON_EXTRACT(r.snapshot_json,'$.capacity')) AS UNSIGNED);
 IF ROW_COUNT()=0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='KIDS_SESSION_CAPACITY'; END IF;
 SET NEW.session_id=v_session;SET NEW.capacity_revision_id=v_revision;
 END IF;END`);
triggers.push(`CREATE TRIGGER fh_capacity_kids_update AFTER UPDATE ON kids_checkins FOR EACH ROW BEGIN
 IF OLD.session_id IS NOT NULL THEN
 IF NOT(OLD.session_id <=> NEW.session_id) OR NOT(OLD.capacity_revision_id <=> NEW.capacity_revision_id) OR NOT(OLD.room_id <=> NEW.room_id) OR NOT(OLD.organization_id <=> NEW.organization_id) OR NOT(OLD.campus_id <=> NEW.campus_id) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='KIDS_SESSION_LINK_IMMUTABLE';END IF;
 IF OLD.status IN ('CHECKED_IN','CALLING_PARENTS') AND NEW.status NOT IN ('CHECKED_IN','CALLING_PARENTS') THEN
 UPDATE intelligence_kids_sessions SET occupied=GREATEST(0,occupied-1) WHERE organization_id=OLD.organization_id AND id=OLD.session_id;
 ELSEIF OLD.status NOT IN ('CHECKED_IN','CALLING_PARENTS') AND NEW.status IN ('CHECKED_IN','CALLING_PARENTS') THEN
 UPDATE intelligence_kids_sessions s INNER JOIN intelligence_capacity_revisions r ON r.organization_id=s.organization_id AND r.id=s.capacity_revision_id
 SET s.occupied=s.occupied+1 WHERE s.organization_id=NEW.organization_id AND s.id=NEW.session_id AND s.status='OPEN' AND s.occupied<CAST(JSON_UNQUOTE(JSON_EXTRACT(r.snapshot_json,'$.capacity')) AS UNSIGNED);
 IF ROW_COUNT()=0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='KIDS_SESSION_CAPACITY'; END IF;
 END IF;END IF;END`);
triggers.push(`CREATE TRIGGER fh_capacity_kids_delete AFTER DELETE ON kids_checkins FOR EACH ROW BEGIN
 IF OLD.session_id IS NOT NULL AND OLD.status IN ('CHECKED_IN','CALLING_PARENTS') THEN UPDATE intelligence_kids_sessions SET occupied=GREATEST(0,occupied-1) WHERE organization_id=OLD.organization_id AND id=OLD.session_id;END IF;END`);
// MySQL SELECT INTO requires local variables, not NEW fields.
triggers[triggers.findIndex(t=>t.startsWith('CREATE TRIGGER fh_capacity_ticket_insert'))]=triggers.find(t=>t.startsWith('CREATE TRIGGER fh_capacity_ticket_insert')).replace('SELECT revision_id INTO NEW.capacity_revision_id','SELECT revision_id INTO v_revision').replace(' END IF;END IF;END',' SET NEW.capacity_revision_id=v_revision; END IF;END IF;END');
// Source tables span legacy utf8mb4 collations; compare identifiers explicitly.
const normalizedTriggers=triggers.map(sql=>sql
 .replace(/DECLARE (v_org|v_campus) VARCHAR\(100\)/g,'DECLARE $1 VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
 .replace(/DECLARE (v_session|v_revision) CHAR\(36\)/g,'DECLARE $1 CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
 .replace(/(\borganization_id|\bsource_id|\broom_id)=((?:NEW|OLD)\.(?:organization_id|id|lot_id|room_id))/g,'$1 COLLATE utf8mb4_unicode_ci=$2')
 .replace(/\b(id|ministry_id|event_id|lot_id)=((?:NEW|OLD)\.[a-z_]+)/g,'$1 COLLATE utf8mb4_unicode_ci=$2')
 .replace(/f\.organization_id IN/g,'f.organization_id COLLATE utf8mb4_unicode_ci IN')
 .replace(/f\.campus_id=/g,'f.campus_id COLLATE utf8mb4_unicode_ci=')
 .replace(/(NEW|OLD)\.organization_id<>v_org/g,'$1.organization_id COLLATE utf8mb4_unicode_ci<>v_org'));
module.exports={tables,columns,triggers:normalizedTriggers};
