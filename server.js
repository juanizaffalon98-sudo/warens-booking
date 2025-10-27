import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { pool, initSchema, withTx } from './db.js';
import nodemailer from 'nodemailer';

dotenv.config();
const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ===================== CORS ===================== */
const external = (process.env.RENDER_EXTERNAL_URL || '').trim();
const selfOrigin = (process.env.SELF_ORIGIN || '').trim();
const baseAllowed = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const allowedSet = new Set([
  ...baseAllowed,
  ...(external ? [external] : []),
  ...(selfOrigin ? [selfOrigin] : []),
]);

app.use(cors({
  origin: (origin, cb) => {
    // Admin HTML (misma origin) o llamadas server-to-server
    if (!origin) return cb(null, true);
    if (allowedSet.has(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'), false);
  }
}));

/* ===================== SLOTS ===================== */
/** Orden visible en disponibilidad y en el panel */
const SLOT_ORDER = ['C', 'A', 'B']; // C=10–12, A=13–15, B=15–17

/** Definición real de los slots (agregá aquí los que quieras) */
const SLOT_MAP = {
  C: { start: '10:00', end: '12:00' },
  A: { start: '13:00', end: '15:00' },
  B: { start: '15:00', end: '17:00' }
};

/** Conjunto válido de claves de slot (se usa para validar en endpoints) */
const SLOT_KEYS = Object.keys(SLOT_MAP);

/* “Reserva” fantasma para bloquear al cerrar un cupo desde el admin */
const ADMIN_NAME  = 'Administrador';
const ADMIN_PHONE = '0';
const ADMIN_IG    = 'admin';

/* ===================== FECHAS ===================== */
function todayCST() {
  const now = new Date();
  // Día UTC para evitar drift con husos
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
function toISODate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function isWeekday(d) {
  const wd = d.getUTCDay();
  return wd >= 1 && wd <= 5; // Lun–Vie
}
function rollingWindow(startStr, days = 14) {
  const start = new Date(`${startStr}T00:00:00Z`);
  const arr = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    if (isWeekday(d)) arr.push(toISODate(d));
  }
  return arr;
}

/* ===================== MAILER ===================== */
const EMAIL_ENABLED = String(process.env.EMAIL_ENABLED || 'true').toLowerCase() === 'true';
const FROM_EMAIL  = process.env.FROM_EMAIL || 'no-reply@warensfinancial.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'juan@warensfinancial.com';

let transporter = null;
if (EMAIL_ENABLED) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

async function sendAdminEmail(b) {
  if (!EMAIL_ENABLED || !transporter) return;
  const html = `
    <h2>Nueva reserva confirmada</h2>
    <p><b>Nombre:</b> ${b.full_name}</p>
    <p><b>Email:</b> ${b.email || '-'}</p>
    <p><b>Teléfono:</b> ${b.phone}</p>
    <p><b>Instagram:</b> ${b.instagram}</p>
    <p><b>Fecha:</b> ${b.date} — <b>Horario:</b> ${SLOT_MAP[b.slot].start}–${SLOT_MAP[b.slot].end}</p>
    <p><b>ID:</b> ${b.id}</p>
  `;
  await transporter.sendMail({
    from: `Warens Booking <${FROM_EMAIL}>`,
    to: ADMIN_EMAIL,
    subject: `Nueva reserva – ${b.full_name} (${b.date} ${b.slot})`,
    html
  });
}

async function sendClientEmail(b) {
  if (!EMAIL_ENABLED || !transporter || !b.email) return;
  const html = `
    <p>Gracias <b>${b.full_name}</b>, tu turno fue reservado con éxito.</p>
    <p><b>Fecha:</b> ${b.date}<br>
       <b>Horario:</b> ${SLOT_MAP[b.slot].start}–${SLOT_MAP[b.slot].end}</p>
    <p>Datos registrados: ${b.email} · ${b.phone} · ${b.instagram}</p>
    <p>— Warens Financial Group</p>
  `;
  await transporter.sendMail({
    from: `Warens Booking <${FROM_EMAIL}>`,
    to: b.email,
    subject: `Confirmación de reserva – ${b.date}`,
    html
  });
}

/* ===================== PÚBLICO ===================== */
app.get('/availability', async (req, res) => {
  const start = req.query.start || toISODate(todayCST());
  const days = Math.min(parseInt(req.query.days || '14', 10), 31);

  const dates = rollingWindow(start, days);
  if (!dates.length) return res.json([]);

  const { rows: bookings } = await pool.query(
    `SELECT date::text, slot FROM bookings WHERE date >= $1 AND date <= $2`,
    [dates[0], dates[dates.length - 1]]
  );
  const { rows: overrides } = await pool.query(
    `SELECT date::text, slot, is_open FROM slot_overrides WHERE date >= $1 AND date <= $2`,
    [dates[0], dates[dates.length - 1]]
  );

  const bookedSet  = new Set(bookings.map(b => `${b.date}|${b.slot}`));
  const overrideMp = new Map(overrides.map(o => [`${o.date}|${o.slot}`, o.is_open]));

  const out = dates.map(date => {
    const o = { date };
    // mostramos en el orden configurado, pero sólo los que estén definidos
    const order = SLOT_ORDER.filter(k => SLOT_KEYS.includes(k));
    for (const s of order) {
      const key = `${date}|${s}`;
      const booked = bookedSet.has(key);
      let open = !booked;
      if (overrideMp.has(key)) open = overrideMp.get(key) && !booked;
      o[s] = { open, booked, label: `${SLOT_MAP[s].start} - ${SLOT_MAP[s].end}` };
    }
    return o;
  });

  res.json(out);
});

app.post('/book', async (req, res) => {
  const { full_name, phone, instagram, email, date, slot } = req.body || {};
  if (!full_name || !phone || !instagram || !date || !SLOT_KEYS.includes(slot)) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  const start = toISODate(todayCST());
  const valid = new Set(rollingWindow(start, 14));
  if (!valid.has(date)) return res.status(400).json({ error: 'Fecha fuera de ventana o no hábil' });

  try {
    const result = await withTx(async (client) => {
      const q = await client.query('SELECT 1 FROM bookings WHERE date=$1 AND slot=$2 FOR UPDATE', [date, slot]);
      if (q.rowCount > 0) throw new Error('Ese turno ya fue reservado');

      const o = await client.query('SELECT is_open FROM slot_overrides WHERE date=$1 AND slot=$2', [date, slot]);
      if (o.rowCount > 0 && o.rows[0].is_open === false) throw new Error('Ese turno está cerrado');

      const ins = await client.query(
        `INSERT INTO bookings (full_name, phone, instagram, email, date, slot)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, full_name, phone, instagram, email, date::text as date, slot, created_at`,
        [full_name, phone, instagram, email || null, date, slot]
      );
      return ins.rows[0];
    });

    // Envíos en background (no bloquean la respuesta)
    Promise.allSettled([sendAdminEmail(result), sendClientEmail(result)]).catch(() => {});
    res.json({ ok: true, booking_id: result.id, created_at: result.created_at });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

/* ===================== ADMIN ===================== */
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (token && token === process.env.ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.get('/admin/api/bookings', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  const params = [];
  let where = '1=1';
  if (from) { params.push(from); where += ` AND date >= $${params.length}`; }
  if (to)   { params.push(to);   where += ` AND date <= $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT id, full_name, phone, instagram, email, date::text, slot, created_at
     FROM bookings
     WHERE ${where}
     ORDER BY date, slot`, params
  );
  res.json(rows);
});

/** Abrir/Cerrar cupo (ahora acepta cualquier clave definida en SLOT_MAP) */
app.post('/admin/api/slot', requireAuth, async (req, res) => {
  const { date, slot, is_open } = req.body || {};
  if (!date || !SLOT_KEYS.includes(slot) || typeof is_open !== 'boolean') {
    return res.status(400).json({ error: 'Datos inválidos' });
  }
  try {
    const result = await withTx(async (client) => {
      // set override
      await client.query(
        `INSERT INTO slot_overrides (date, slot, is_open)
         VALUES ($1,$2,$3)
         ON CONFLICT (date, slot) DO UPDATE SET is_open = EXCLUDED.is_open`,
        [date, slot, is_open]
      );

      if (is_open) {
        // si abrimos, quitamos posible bloque admin
        const del = await client.query(
          `DELETE FROM bookings WHERE date=$1 AND slot=$2 AND phone=$3 AND instagram=$4`,
          [date, slot, ADMIN_PHONE, ADMIN_IG]
        );
        return { opened: true, removed_admin_block: del.rowCount > 0 };
      } else {
        // si cerramos y no hay reserva, insertamos bloque admin
        const ex = await client.query(`SELECT id FROM bookings WHERE date=$1 AND slot=$2 FOR UPDATE`, [date, slot]);
        if (ex.rowCount === 0) {
          const ins = await client.query(
            `INSERT INTO bookings (full_name, phone, instagram, email, date, slot)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [ADMIN_NAME, ADMIN_PHONE, ADMIN_IG, null, date, slot]
          );
          return { closed: true, created_admin_block: true, id: ins.rows[0].id };
        }
        return { closed: true, created_admin_block: false };
      }
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('admin/slot', e);
    res.status(500).json({ error: 'No se pudo actualizar el cupo' });
  }
});

app.get('/admin/api/bookings.csv', requireAuth, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, full_name, phone, instagram, email, date::text, slot, created_at
     FROM bookings
     ORDER BY date, slot`
  );
  const header = 'id,full_name,phone,instagram,email,date,slot,created_at';
  const lines = rows.map(r => [
    r.id,
    JSON.stringify(r.full_name),
    JSON.stringify(r.phone),
    JSON.stringify(r.instagram),
    JSON.stringify(r.email || ''),
    r.date,
    r.slot,
    r.created_at.toISOString()
  ].join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="bookings.csv"');
  res.send([header, ...lines].join('\n'));
});

app.delete('/admin/api/booking/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });
    const result = await pool.query('DELETE FROM bookings WHERE id=$1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Reserva no encontrada' });
    res.json({ ok: true });
  } catch (e) {
    console.error('admin delete', e);
    res.status(500).json({ error: 'Fallo al cancelar la reserva' });
  }
});

/* ===================== START ===================== */
if (process.argv.includes('--init-db')) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  initSchema(sql)
    .then(() => { console.log('DB schema initialized'); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
} else {
  app.get('/healthz', (_req, res) => res.send('ok'));
  const port = process.env.PORT || 3000;
  app.listen(port, () =>
    console.log('Server on', port, 'allowed:', Array.from(allowedSet))
  );
}
