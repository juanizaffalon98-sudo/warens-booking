-- bookings: cada reserva confirmada
CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  instagram TEXT NOT NULL,
  date DATE NOT NULL,
  slot CHAR(1) NOT NULL CHECK (slot IN ('A','B')), -- A=13-15, B=15-17
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (date, slot)
);

-- slot_overrides: abrir/cerrar manualmente cupos
CREATE TABLE IF NOT EXISTS slot_overrides (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  slot CHAR(1) NOT NULL CHECK (slot IN ('A','B')),
  is_open BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (date, slot)
);
