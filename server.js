require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const SALLA_TOKEN = process.env.SALLA_ACCESS_TOKEN;
const PER_PAGE = parseInt(process.env.PER_PAGE || '30', 10);

if (!SALLA_TOKEN) {
  console.warn('⚠️  تحذير: لم يتم ضبط SALLA_ACCESS_TOKEN في متغيرات البيئة. الموقع لن يعمل بدونه.');
}

const salla = axios.create({
  baseURL: 'https://api.salla.dev/admin/v2',
  headers: { Authorization: `Bearer ${SALLA_TOKEN}` },
  timeout: 20000,
});

// -------------------- أدوات مساعدة --------------------

// تنفيذ عدة طلبات بحد أقصى للتزامن (عشان لا نضرب Rate Limit في سلة)
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function next() {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await worker(items[current], current);
      } catch (err) {
        results[current] = { __error: true, message: err.message };
      }
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, next);
  await Promise.all(runners);
  return results;
}

// جلب كل الطلبات لحالة معينة (بترقيم صفحات متسلسل كما توصي سلة)
async function fetchOrdersList(statusSlug, maxOrders) {
  const orders = [];
  let page = 1;
  let totalPages = 1;

  do {
    const { data } = await salla.get('/orders', {
      params: { status: statusSlug, per_page: PER_PAGE, page },
    });
    const pageOrders = data.data || [];
    orders.push(...pageOrders);
    totalPages = data.pagination ? data.pagination.totalPages : 1;
    page += 1;
  } while (page <= totalPages && orders.length < maxOrders);

  return orders.slice(0, maxOrders);
}

// جلب تفاصيل طلب واحد (فيها الخيارات/SKU الدقيقة)
async function fetchOrderDetails(orderId) {
  const { data } = await salla.get(`/orders/${orderId}`);
  return data.data;
}

// تجهيز اسم/مفتاح موحد لكل عنصر (صنف + خيارات)
function normalizeItem(item) {
  const options = Array.isArray(item.options)
    ? item.options.map((o) => {
        const name = o.name || o.option_name || '';
        let value = o.value;
        if (value && typeof value === 'object') value = value.name || value.value || JSON.stringify(value);
        return `${name}: ${value}`;
      })
    : [];

  const optionsLabel = options.join('، ');
  const sku = item.sku || item.product_sku || null;
  const productId = item.product_id || item.product?.id || null;

  // مفتاح فريد لتمييز نفس الصنف بنفس الخيارات عن غيره
  const key = sku || `${productId || item.name}__${optionsLabel}`;

  return {
    key,
    productId,
    sku,
    name: item.name || item.product?.name || 'بدون اسم',
    optionsLabel,
    quantity: Number(item.quantity || 0),
  };
}

// -------------------- المنطق الأساسي --------------------

async function buildPrepList(statusSlug, maxOrders) {
  const orderSummaries = await fetchOrdersList(statusSlug, maxOrders);

  if (orderSummaries.length === 0) {
    return { statusSlug, totalOrders: 0, aggregate: [], clusters: [], singles: [], fetchedAt: new Date().toISOString() };
  }

  // نجلب تفاصيل كل طلب (فيها الخيارات) بتزامن محدود
  const detailsList = await runWithConcurrency(orderSummaries, 5, (o) => fetchOrderDetails(o.id));

  const aggregateMap = new Map(); // key -> { ...info, totalQty, orderIds:Set }
  const fingerprintMap = new Map(); // signature -> { items:[], orders:[] }

  for (let i = 0; i < detailsList.length; i++) {
    const details = detailsList[i];
    const summary = orderSummaries[i];
    if (!details || details.__error) continue;

    const rawItems = details.items || [];
    const items = rawItems.map(normalizeItem).filter((it) => it.quantity > 0);
    if (items.length === 0) continue;

    // تجميع كلي حسب الصنف/الخيار
    for (const it of items) {
      if (!aggregateMap.has(it.key)) {
        aggregateMap.set(it.key, {
          key: it.key,
          name: it.name,
          optionsLabel: it.optionsLabel,
          sku: it.sku,
          totalQty: 0,
          orderIds: new Set(),
        });
      }
      const agg = aggregateMap.get(it.key);
      agg.totalQty += it.quantity;
      agg.orderIds.add(details.id);
    }

    // بصمة الطلب (تركيبة العناصر مرتبة) لتجميع الطلبات المتطابقة
    const sortedItems = [...items].sort((a, b) => String(a.key).localeCompare(String(b.key)));
    const signature = sortedItems.map((it) => `${it.key}x${it.quantity}`).join('|');

    if (!fingerprintMap.has(signature)) {
      fingerprintMap.set(signature, { items: sortedItems, orders: [] });
    }
    fingerprintMap.get(signature).orders.push({
      id: details.id,
      reference_id: details.reference_id || summary.reference_id,
      customerName: details.customer?.full_name || summary.customer?.full_name || '—',
    });
  }

  const aggregate = Array.from(aggregateMap.values())
    .map((a) => ({ ...a, orderCount: a.orderIds.size, orderIds: undefined }))
    .sort((a, b) => b.totalQty - a.totalQty);

  const allGroups = Array.from(fingerprintMap.values()).sort((a, b) => b.orders.length - a.orders.length);
  const clusters = allGroups.filter((g) => g.orders.length > 1);
  const singles = allGroups.filter((g) => g.orders.length === 1).map((g) => ({ items: g.items, order: g.orders[0] }));

  return {
    statusSlug,
    totalOrders: orderSummaries.length,
    aggregate,
    clusters,
    singles,
    fetchedAt: new Date().toISOString(),
  };
}

// -------------------- الحماية (Basic Auth) --------------------
// يمنع أي شخص من فتح الموقع بدون اسم مستخدم وكلمة مرور صحيحين

const SITE_USERNAME = process.env.SITE_USERNAME;
const SITE_PASSWORD = process.env.SITE_PASSWORD;

function requireAuth(req, res, next) {
  if (!SITE_USERNAME || !SITE_PASSWORD) {
    // إذا لم تُضبط بيانات الدخول، امنع الوصول تمامًا بدل ترك الموقع مفتوحًا بالخطأ
    return res.status(500).send('لم يتم ضبط بيانات الدخول (SITE_USERNAME / SITE_PASSWORD) على السيرفر.');
  }

  const authHeader = req.headers.authorization || '';
  const [scheme, encoded] = authHeader.split(' ');

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sepIndex = decoded.indexOf(':');
    const user = decoded.slice(0, sepIndex);
    const pass = decoded.slice(sepIndex + 1);

    if (user === SITE_USERNAME && pass === SITE_PASSWORD) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="تجهيز الطلبات"');
  return res.status(401).send('يتطلب تسجيل الدخول');
}

// -------------------- المسارات (Routes) --------------------

app.use(requireAuth);
app.use(express.static('public'));
app.use(express.json());

// الحالات المتاحة: under_review = بانتظار المراجعة | in_progress = قيد التنفيذ
app.get('/api/prep-list/:statusSlug', async (req, res) => {
  const { statusSlug } = req.params;
  const maxOrders = parseInt(req.query.max || '300', 10);

  if (!SALLA_TOKEN) {
    return res.status(500).json({ error: 'لم يتم ضبط SALLA_ACCESS_TOKEN على السيرفر' });
  }

  try {
    const result = await buildPrepList(statusSlug, maxOrders);
    res.json(result);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      error: 'فشل جلب البيانات من سلة',
      details: err.response?.data || err.message,
    });
  }
});

const isVercel = !!process.env.VERCEL;

if (!isVercel) {
  app.listen(PORT, () => {
    console.log(`✅ السيرفر يعمل على المنفذ ${PORT}`);
  });
}

module.exports = app;
