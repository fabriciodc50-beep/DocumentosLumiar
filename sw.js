// Service worker do Painel de Contas.
// Além de deixar showNotification() mais confiável, tenta rodar em segundo plano
// (Periodic Background Sync, quando o navegador permite) pra checar contas a vencer
// mesmo sem o app estar aberto. Suporte real disso depende do Android/Chrome —
// não existe garantia igual a um alarme nativo de app instalado.

const DB_NOME = 'painel-contas-sw';
const STORE = 'snapshot';
const STORE_NOTIFICADAS = 'notificadas';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientList) => {
      if (clientList.length > 0) return clientList[0].focus();
      return self.clients.openWindow('/');
    })
  );
});

function abrirDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NOME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      if (!req.result.objectStoreNames.contains(STORE_NOTIFICADAS)) req.result.createObjectStore(STORE_NOTIFICADAS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function lerSnapshot(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get('atual');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function lerNotificadas(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NOTIFICADAS, 'readonly');
    const req = tx.objectStore(STORE_NOTIFICADAS).get('mapa');
    req.onsuccess = () => resolve(req.result || {});
    req.onerror = () => reject(req.error);
  });
}

function salvarNotificadas(db, mapa) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NOTIFICADAS, 'readwrite');
    tx.objectStore(STORE_NOTIFICADAS).put(mapa, 'mapa');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function diasAte(dataIso) {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const venc = new Date(dataIso);
  venc.setHours(0, 0, 0, 0);
  return Math.round((venc.getTime() - hoje.getTime()) / 86400000);
}

async function verificarContasEmSegundoPlano() {
  const db = await abrirDB();
  const snapshot = await lerSnapshot(db);
  if (!snapshot) return;

  const agora = new Date();
  const horaNotificacao = snapshot.horaNotificacao ?? 9;
  if (agora.getHours() < horaNotificacao) return;

  const diasAntes = snapshot.avisarComDiasAntes ?? [3, 1, 0];
  const hojeChave = agora.toISOString().slice(0, 10);
  const notificadas = await lerNotificadas(db);

  for (const conta of snapshot.contas) {
    if (conta.pago) continue;
    const dias = diasAte(conta.vencimento);
    const deveAvisar = dias < 0 || diasAntes.includes(dias);
    if (!deveAvisar) continue;

    const chave = String(conta.id);
    if (notificadas[chave] === hojeChave) continue;

    const corpo =
      dias < 0
        ? `${conta.titulo} está atrasada há ${Math.abs(dias)} dia${Math.abs(dias) !== 1 ? 's' : ''}`
        : dias === 0
          ? `${conta.titulo} vence hoje`
          : `${conta.titulo} vence em ${dias} dia${dias !== 1 ? 's' : ''}`;

    await self.registration.showNotification('🔔 Painel de Contas', {
      body: corpo,
      tag: `conta-${conta.id}`,
      icon: '/favicon.svg',
    });
    notificadas[chave] = hojeChave;
  }

  await salvarNotificadas(db, notificadas);
  db.close();
}

// Roda quando o navegador decide (não garantido, depende do Android/Chrome permitir)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'verificar-contas') {
    event.waitUntil(verificarContasEmSegundoPlano());
  }
});

// Fallback pra navegadores que só suportam sync único (dispara ao reconectar internet, por exemplo)
self.addEventListener('sync', (event) => {
  if (event.tag === 'verificar-contas-uma-vez') {
    event.waitUntil(verificarContasEmSegundoPlano());
  }
});
