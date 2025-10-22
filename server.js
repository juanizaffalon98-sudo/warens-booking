import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { pool, initSchema, withTx } from './db.js';

dotenv.config();
const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- CORS ----
const allowed = process.env.ALLOWED_ORIGIN?.split(',').map(s => s.trim()).filter(Boolean) || [];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowed.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'), false);
  }
}));

// ---- Slots ----
const SLOT_MAP = { A: { start: '13:00', end: '15:00' }, B: { start: '15:00', end: '17:00' } };

function todayCST() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
function toISODate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,'0');
  const day = String(d.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function isWeekday(d) {
  const wd = d.getUTCDay(); // 1..5 = lun..vie
  return wd >= 1 && wd <= 5;
}
function rollingWindow(startStr, days=14) {
  const start = new Date(`${startStr}T00:00:00Z`);
  const arr = [];
  for (let i=0; i<days; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    if (isWeekday(d)) arr.push(toISODate(d));
  }
  return arr;
}

// ---------- PÚBLICO ----------
app.get('/availability', async (req, res) => {
  const start = req.query.start || toISODate(todayCST());
  const days = Math.min(parseInt(req.query.days || '14', 10), 31);

  const dates = rollingWindow(start, days);
  if (dates.length === 0) return res.json([]);

  const { rows: bookings } = await pool.query(
    `SELECT id, date::text, slot FROM bookings
     WHERE date >= $1 AND date <= $2`,
    [dates[0], dates[dates.length-1]]
  );

  const { rows: overrides } = await pool.query(
    `SELECT date::text, slot, is_open FROM slot_overrides
     WHERE date >= $1 AND date <= $2`,
    [dates[0], dates[dates.length-1]]
  );

  const bookedSet = new Set(bookings.map(b => `${b.date}|${b.slot}`));
  const overrideMap = new Map(overrides.map(o => [`${o.date}|${o.slot}`, o.is_open]));

  const out = dates.map(date => {
    const slots = {};
    for (const s of ['A','B']) {
      const key = `${date}|${s}`;
      const booked = bookedSet.has(key);
      let open = !booked;
      if (overrideMap.has(key)) {
        const forced = overrideMap.get(key);
        open = forced && !booked; // false = cerrado; true = abierto (si no está reservado)
      }
      slots[s] = { open, booked, label: `${SLOT_MAP[s].start} - ${SLOT_MAP[s].end}` };
    }
    return { date, ...slots };
  });

  res.json(out);
});

app.post('/book', async (req, res) => {
  const { full_name, phone, instagram, date, slot } = req.body || {};
  if (!full_name || !phone || !instagram || !date || !['A','B'].includes(slot)) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  const start = toISODate(todayCST());
  const validDates = new Set(rollingWindow(start, 14));
  if (!validDates.has(date)) return res.status(400).json({ error: 'Fecha fuera de ventana o no hábil' });

  try {
    const result = await withTx(async (client) => {
      const q = await client.query(
        'SELECT 1 FROM bookings WHERE date=$1 AND slot=$2 FOR UPDATE',
        [date, slot]
      );
      if (q.rowCount > 0) throw new Error('Ese turno ya fue reservado');

      const o = await client.query(
        'SELECT is_open FROM slot_overrides WHERE date=$1 AND slot=$2',
        [date, slot]
      );
      if (o.rowCount > 0 && o.rows[0].is_open === false) throw new Error('Ese turno está cerrado');

      const ins = await client.query(
        `INSERT INTO bookings (full_name, phone, instagram, date, slot)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, created_at`,
        [full_name, phone, instagram, date, slot]
      );
      return ins.rows[0];
    });

    res.json({ ok: true, booking_id: result.id, created_at: result.created_at });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

// ---------- ADMIN ----------
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ','').trim();
  if (token && token === process.env.ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Listado de reservas
app.get('/admin/api/bookings', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  const params = [];
  let where = '1=1';
  if (from) { params.push(from); where += ` AND date >= $${params.length}`; }
  if (to)   { params.push(to);   where += ` AND date <= $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT id, full_name, phone, instagram, date::text, slot, created_at
     FROM bookings
     WHERE ${where}
     ORDER BY date, slot`, params
  );
  res.json(rows);
});

// Abrir/cerrar cupo manual
app.post('/admin/api/slot', requireAuth, async (req, res) => {
  const { date, slot, is_open } = req.body || {};
  if (!date || !['A','B'].includes(slot) || typeof is_open !== 'boolean') {
    return res.status(400).json({ error: 'Datos inválidos' });
  }
  await pool.query(
    `INSERT INTO slot_overrides (date, slot, is_open)
     VALUES ($1,$2,$3)
     ON CONFLICT (date, slot) DO UPDATE SET is_open = EXCLUDED.is_open`,
    [date, slot, is_open]
  );
  res.json({ ok: true });
});

// CSV
app.get('/admin/api/bookings.csv', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, full_name, phone, instagram, date::text, slot, created_at
     FROM bookings ORDER BY date, slot`
  );
  const header = 'id,full_name,phone,instagram,date,slot,created_at';
  const lines = rows.map(r => [
    r.id, JSON.stringify(r.full_name), JSON.stringify(r.phone),
    JSON.stringify(r.instagram), r.date, r.slot, r.created_at.toISOString()
  ].join(','));
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="bookings.csv"');
  res.send([header, ...lines].join('\n'));
});

// NUEVO: cancelar reserva (libera el cupo)
app.delete('/admin/api/booking/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const { rowCount } = await pool.query('DELETE FROM bookings WHERE id=$1', [id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Reserva no encontrada' });
  res.json({ ok: true });
});

// ---------- Init DB o servidor ----------
if (process.argv.includes('--init-db')) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  initSchema(sql)
    .then(() => { console.log('DB schema initialized'); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
} else {
  app.get('/healthz', (_, res) => res.send('ok'));
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Server on', port));
}
