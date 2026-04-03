-- Tabela de Grupos/Células
CREATE TABLE IF NOT EXISTS cell_groups (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    leader_id VARCHAR(36),
    description TEXT,
    address VARCHAR(500),
    neighborhood VARCHAR(100),
    meeting_day VARCHAR(50),
    meeting_time VARCHAR(20),
    whatsapp_contact VARCHAR(20),
    status VARCHAR(50) DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Tabela de Membros
CREATE TABLE IF NOT EXISTS members (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    role VARCHAR(50) DEFAULT 'MEMBER', 
    status VARCHAR(50) DEFAULT 'ACTIVE',
    cpf VARCHAR(14),
    baptism_date DATE,
    cell_group_id VARCHAR(36),
    phone VARCHAR(20),
    activation_date TIMESTAMP NULL,
    invited_by VARCHAR(36),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (cell_group_id) REFERENCES cell_groups(id) ON DELETE SET NULL,
    FOREIGN KEY (invited_by) REFERENCES members(id) ON DELETE SET NULL
);

-- Tabela de Transmissões ao Vivo
CREATE TABLE IF NOT EXISTS broadcasts (
    id VARCHAR(36) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    observation TEXT,
    youtube_url VARCHAR(500) NOT NULL,
    is_available BOOLEAN DEFAULT FALSE,
    scheduled_for DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
