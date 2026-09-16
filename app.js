// Plain vanilla JS, no framework, no build step — talks to Supabase's
// PostgREST RPC endpoints directly via fetch(). This page has no session
// at all; the token in the URL is the entire access credential, and every
// call below re-validates it server-side (see the mubrram repo's
// supabase/migrations/20260916000003_share_link_anon_rpcs.sql for what
// each RPC actually checks).

const STATUS_LABELS = {
  draft: 'مسودة',
  sent: 'مُرسل',
  accepted: 'مقبول',
  rejected: 'مرفوض',
  expired: 'منتهي',
};

// In-memory only, deliberately never written to localStorage/sessionStorage
// — a reload means re-entering the 4 digits, which is a small amount of
// friction traded for not persisting a bearer-token-like value in browser
// storage on what may be a shared device.
let verificationToken = null;
let currentDocument = null;
let currentDecision = null; // 'accepted' | 'rejected' — set right before opening the identity modal

function getToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get('token');
}

async function callRpc(fnName, params) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message || 'request_failed');
  }
  return body;
}

function formatAmount(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function showState(id) {
  for (const el of document.querySelectorAll('#app > .state, #app > .doc')) {
    el.hidden = el.id !== id;
  }
}

function renderQuotation(doc, verified) {
  currentDocument = doc;

  document.getElementById('q-status').textContent = STATUS_LABELS[doc.status] || doc.status;
  document.getElementById('q-status').className = `badge badge-${doc.status}`;
  document.getElementById('q-title').textContent = doc.title;
  document.getElementById('q-number').textContent = doc.quotation_number ? `رقم العرض: ${doc.quotation_number}` : '';
  document.getElementById('q-client-name').textContent = doc.client || '—';
  document.getElementById('q-seller-name').textContent = doc.seller_name || '—';

  const lineItems = doc.line_items || [];
  const scopeTextEl = document.getElementById('q-scope-text');
  const lineItemsEl = document.getElementById('q-line-items');
  if (lineItems.length > 0) {
    scopeTextEl.hidden = true;
    lineItemsEl.hidden = false;
    lineItemsEl.innerHTML = lineItems
      .map((li) => `<tr><td>${escapeHtml(li.description)}</td><td>${formatAmount(li.price)} ر.س</td></tr>`)
      .join('');
  } else {
    scopeTextEl.hidden = false;
    lineItemsEl.hidden = true;
    scopeTextEl.textContent = doc.scope || '—';
  }

  document.getElementById('q-total').textContent = `${formatAmount(doc.total)} ر.س`;

  const validUntilRow = document.getElementById('q-valid-until-row');
  if (doc.valid_until) {
    validUntilRow.hidden = false;
    document.getElementById('q-valid-until').textContent = doc.valid_until;
  } else {
    validUntilRow.hidden = true;
  }

  const notesSection = document.getElementById('q-notes-section');
  if (doc.notes) {
    notesSection.hidden = false;
    document.getElementById('q-notes').textContent = doc.notes;
  } else {
    notesSection.hidden = true;
  }

  const actions = document.getElementById('q-decision-actions');
  const decidedNote = document.getElementById('q-decided-note');
  if (doc.status === 'sent') {
    actions.hidden = false;
    decidedNote.hidden = true;
  } else {
    actions.hidden = true;
    if (doc.status === 'accepted' || doc.status === 'rejected') {
      decidedNote.hidden = false;
      decidedNote.textContent =
        doc.status === 'accepted' ? 'تم قبول هذا العرض.' : 'تم رفض هذا العرض.';
    } else {
      decidedNote.hidden = true;
    }
  }

  showState('state-quotation');
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ── Identity modal ──────────────────────────────────────────────────────

function openIdentityModal() {
  const modal = document.getElementById('identity-modal');
  const input = document.getElementById('identity-input');
  const error = document.getElementById('identity-error');
  const confirmBtn = document.getElementById('identity-confirm-btn');

  input.value = '';
  error.hidden = true;
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'تأكيد ومتابعة';
  modal.hidden = false;
  input.focus();
}

function closeIdentityModal() {
  document.getElementById('identity-modal').hidden = true;
}

async function submitIdentity() {
  const token = getToken();
  const input = document.getElementById('identity-input');
  const error = document.getElementById('identity-error');
  const confirmBtn = document.getElementById('identity-confirm-btn');
  const digits = input.value.trim();

  if (!/^\d{4}$/.test(digits)) {
    error.hidden = false;
    error.textContent = 'أدخل 4 أرقام';
    return;
  }

  confirmBtn.disabled = true;
  confirmBtn.textContent = '...جارٍ التحقق';
  error.hidden = true;

  try {
    const result = await callRpc('verify_client_identity', {
      p_token: token,
      p_last_4_digits: digits,
    });

    if (result.success) {
      verificationToken = result.verification_token;
      closeIdentityModal();
      if (currentDecision) {
        await submitDecision(currentDecision);
      }
      return;
    }

    error.hidden = false;
    error.textContent = result.locked_until
      ? 'محاولات كثيرة خاطئة. حاول مرة أخرى لاحقاً.'
      : 'الأرقام غير صحيحة، حاول مرة أخرى';
  } catch (e) {
    error.hidden = false;
    error.textContent =
      e.message === 'too_many_attempts'
        ? 'محاولات كثيرة خاطئة. حاول مرة أخرى لاحقاً.'
        : 'حدث خطأ، حاول مرة أخرى';
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'تأكيد ومتابعة';
  }
}

// ── Decision (accept/decline) ───────────────────────────────────────────

function requestDecision(decision) {
  currentDecision = decision;
  if (verificationToken) {
    submitDecision(decision);
    return;
  }
  openIdentityModal();
}

async function submitDecision(decision) {
  const token = getToken();
  try {
    const result = await callRpc('accept_or_decline_quotation', {
      p_token: token,
      p_verification_token: verificationToken,
      p_decision: decision,
    });
    renderQuotation(result.document, result.verified);
  } catch (e) {
    if (e.message === 'not_verified') {
      // The 30-minute verification session lapsed between opening the
      // modal and confirming — ask again rather than dead-ending.
      verificationToken = null;
      openIdentityModal();
      return;
    }
    showState('state-error');
  } finally {
    currentDecision = null;
  }
}

// ── Init ─────────────────────────────────────────────────────────────────

async function init() {
  const token = getToken();
  if (!token) {
    showState('state-error');
    return;
  }

  try {
    const result = await callRpc('get_shared_document', { p_token: token });
    if (result.document_type === 'quotation') {
      renderQuotation(result.document, result.verified);
    } else {
      // Contract/invoice client views land in later steps — nothing can
      // create a share link of those types yet, so this path is currently
      // unreachable, but fails safely rather than showing a blank page.
      showState('state-error');
    }
  } catch (e) {
    showState('state-error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  init();

  document.getElementById('q-accept-btn').addEventListener('click', () => requestDecision('accepted'));
  document.getElementById('q-decline-btn').addEventListener('click', () => requestDecision('rejected'));
  document.getElementById('q-download-btn').addEventListener('click', () => window.print());

  document.getElementById('identity-confirm-btn').addEventListener('click', submitIdentity);
  document.getElementById('identity-cancel-btn').addEventListener('click', () => {
    currentDecision = null;
    closeIdentityModal();
  });
  document.getElementById('identity-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitIdentity();
  });
});
