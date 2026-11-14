const tables=[
`CREATE TABLE IF NOT EXISTS intelligence_calendar_series (
 organization_id VARCHAR(100) NOT NULL,id CHAR(36) NOT NULL,campus_id VARCHAR(100) NOT NULL,cell_group_id VARCHAR(100) NOT NULL,
 title VARCHAR(120) NOT NULL,start_on DATE NOT NULL,end_on DATE NOT NULL,weekdays JSON NOT NULL,local_time CHAR(5) NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',version INT NOT NULL DEFAULT 0,generated_through DATE NULL,
 request_hash CHAR(64) NOT NULL,created_by VARCHAR(100) NOT NULL,created_at DATETIME(6) NOT NULL,updated_at DATETIME(6) NOT NULL,
 PRIMARY KEY(organization_id,id),KEY idx_calendar_series_scope(organization_id,campus_id,cell_group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS intelligence_calendar_occurrences (
 organization_id VARCHAR(100) NOT NULL,id CHAR(36) NOT NULL,series_id CHAR(36) NOT NULL,campus_id VARCHAR(100) NOT NULL,cell_group_id VARCHAR(100) NOT NULL,
 scheduled_on DATE NOT NULL,starts_at DATETIME NOT NULL,status VARCHAR(20) NOT NULL DEFAULT 'PLANNED',version INT NOT NULL DEFAULT 0,
 meeting_id VARCHAR(100) NULL,attendance_confirmed TINYINT NOT NULL DEFAULT 0,origin_occurrence_id CHAR(36) NULL,
 reason VARCHAR(240) NULL,created_at DATETIME(6) NOT NULL,updated_at DATETIME(6) NOT NULL,
 PRIMARY KEY(organization_id,id),UNIQUE KEY uq_calendar_day(organization_id,series_id,scheduled_on),UNIQUE KEY uq_calendar_meeting(organization_id,meeting_id),
 KEY idx_calendar_occurrence_scope(organization_id,campus_id,cell_group_id,scheduled_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS intelligence_calendar_revisions (
 organization_id VARCHAR(100) NOT NULL,id CHAR(36) NOT NULL,occurrence_id CHAR(36) NOT NULL,campus_id VARCHAR(100) NOT NULL,cell_group_id VARCHAR(100) NOT NULL,
 version INT NOT NULL,snapshot_json JSON NOT NULL,request_hash CHAR(64) NOT NULL,actor_id VARCHAR(100) NOT NULL,recorded_at DATETIME(6) NOT NULL,
 PRIMARY KEY(organization_id,id),UNIQUE KEY uq_calendar_revision(organization_id,occurrence_id,version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];
module.exports={tables};
