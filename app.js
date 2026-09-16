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
// The one action waiting on identity verification — shared by every
// binding action (quotation accept/decline, contract sign) so the
// verify-then-execute flow only needs to exist once.
// { type: 'quotation_decision', decision } | { type: 'contract_sign', signatureData }
let pendingAction = null;

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

// Postgres timestamptz values (e.g. "2026-09-17T10:15:00.123456+00:00")
// render garbled in an RTL context — the bidi algorithm reorders the
// colons/timezone offset unpredictably around the neutral punctuation.
// Trimming to just the date avoids it entirely, matching how dates are
// shown everywhere else on this page (plain "YYYY-MM-DD", no time part).
function formatDateOnly(isoString) {
  if (!isoString) return '';
  const datePart = isoString.split('T')[0];
  return datePart || isoString;
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

const CONTRACT_STATUS_LABELS = {
  draft: 'مسودة',
  sent: 'مُرسل',
  accepted: 'مقبول',
  completed: 'مكتمل',
  cancelled: 'ملغى',
};

function renderContract(doc, verified) {
  currentDocument = doc;

  document.getElementById('c-status').textContent = CONTRACT_STATUS_LABELS[doc.status] || doc.status;
  document.getElementById('c-status').className = `badge badge-${doc.status}`;
  document.getElementById('c-title').textContent = doc.title;
  document.getElementById('c-number').textContent = doc.contract_number ? `رقم العقد: ${doc.contract_number}` : '';
  document.getElementById('c-client-name').textContent = doc.client || '—';
  document.getElementById('c-seller-name').textContent = doc.seller_name || '—';
  document.getElementById('c-scope-text').textContent = doc.scope || '—';
  document.getElementById('c-price').textContent = `${formatAmount(doc.price)} ر.س`;

  const dateRow = document.getElementById('c-date-row');
  if (doc.date) {
    dateRow.hidden = false;
    document.getElementById('c-date').textContent = doc.date;
  } else {
    dateRow.hidden = true;
  }

  const milestonesSection = document.getElementById('c-milestones-section');
  const milestones = doc.milestones || [];
  if (doc.payment_type === 'milestone' && milestones.length > 0) {
    milestonesSection.hidden = false;
    document.getElementById('c-milestones').innerHTML = milestones
      .map((m) => {
        const due = m.due_date ? ` <span class="muted">· ${escapeHtml(m.due_date)}</span>` : '';
        return `<tr><td>${escapeHtml(m.title)}${due}</td><td>${formatAmount(m.amount)} ر.س</td></tr>`;
      })
      .join('');
  } else {
    milestonesSection.hidden = true;
  }

  const signedView = document.getElementById('c-signed-view');
  const signPadSection = document.getElementById('c-sign-pad-section');
  if (doc.signed_at) {
    signedView.hidden = false;
    signPadSection.hidden = true;
    const img = document.getElementById('c-signature-img');
    if (doc.client_signature_data) {
      img.src = doc.client_signature_data;
      img.hidden = false;
    } else {
      img.hidden = true;
    }
    document.getElementById('c-signed-date').textContent =
      `تم التوقيع بتاريخ ${formatDateOnly(doc.signed_at)}`;
  } else {
    signedView.hidden = true;
    signPadSection.hidden = false;
  }

  showState('state-contract');
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

// An Arabic (or Persian/Urdu) keyboard produces Arabic-Indic digits
// (١٢٣٤٥٦٧٨٩٠ / ۰۱۲۳۴۵۶۷۸۹) instead of Western ones for numeric input —
// very common on this exact kind of device/locale, and \d in a JS regex
// only ever matches [0-9]. Without this, a client typing their own real
// phone digits on their own Arabic keyboard would be told they didn't
// enter 4 digits, when they plainly did.
function normalizeDigits(str) {
  const arabicIndic = '٠١٢٣٤٥٦٧٨٩';
  const easternArabicIndic = '۰۱۲۳۴۵۶۷۸۹';
  return str.replace(/[٠-٩۰-۹]/g, (ch) => {
    const i = arabicIndic.indexOf(ch);
    if (i !== -1) return String(i);
    const j = easternArabicIndic.indexOf(ch);
    return j !== -1 ? String(j) : ch;
  });
}

async function submitIdentity() {
  const token = getToken();
  const input = document.getElementById('identity-input');
  const error = document.getElementById('identity-error');
  const confirmBtn = document.getElementById('identity-confirm-btn');
  const digits = normalizeDigits(input.value.trim());

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
      if (pendingAction) {
        await executePendingAction();
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

// ── Binding actions (quotation accept/decline, contract sign) ────────────
// Both go through the same identity gate before touching the server —
// requestX() decides whether verification is still needed, and
// executePendingAction() is the one place that actually calls the
// document-specific RPC once it is.

function requestDecision(decision) {
  pendingAction = { type: 'quotation_decision', decision };
  if (verificationToken) {
    executePendingAction();
    return;
  }
  openIdentityModal();
}

function requestSign(signatureData) {
  pendingAction = { type: 'contract_sign', signatureData };
  if (verificationToken) {
    executePendingAction();
    return;
  }
  openIdentityModal();
}

async function executePendingAction() {
  const action = pendingAction;
  if (!action) return;
  const token = getToken();

  try {
    let result;
    if (action.type === 'quotation_decision') {
      result = await callRpc('accept_or_decline_quotation', {
        p_token: token,
        p_verification_token: verificationToken,
        p_decision: action.decision,
      });
    } else if (action.type === 'contract_sign') {
      result = await callRpc('sign_contract', {
        p_token: token,
        p_verification_token: verificationToken,
        p_signature_data: action.signatureData,
      });
    } else {
      return;
    }

    if (result.document_type === 'quotation') {
      renderQuotation(result.document, result.verified);
    } else if (result.document_type === 'contract') {
      renderContract(result.document, result.verified);
    }
    pendingAction = null;
  } catch (e) {
    if (e.message === 'not_verified') {
      // The 30-minute verification session lapsed between opening the
      // modal and confirming — ask again rather than dead-ending.
      // Deliberately does NOT clear pendingAction: once re-verified,
      // executePendingAction() retries the same action rather than
      // silently dropping it.
      verificationToken = null;
      openIdentityModal();
      return;
    }
    pendingAction = null;
    showState('state-error');
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
    } else if (result.document_type === 'contract') {
      renderContract(result.document, result.verified);
    } else {
      // Invoice client view lands in step 5 — nothing can create a share
      // link of that type yet, so this path is currently unreachable, but
      // fails safely rather than showing a blank page.
      showState('state-error');
    }
  } catch (e) {
    showState('state-error');
  }
}

// ── Signature pad (contract signing) ────────────────────────────────────

function setUpSignaturePad() {
  const canvas = document.getElementById('c-signature-pad');
  const ctx = canvas.getContext('2d');
  const signBtn = document.getElementById('c-sign-btn');
  let drawing = false;
  let hasSignature = false;

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const point = e.touches ? e.touches[0] : e;
    return { x: (point.clientX - rect.left) * scaleX, y: (point.clientY - rect.top) * scaleY };
  }

  function startDraw(e) {
    drawing = true;
    hasSignature = true;
    signBtn.disabled = false;
    const p = getPos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    e.preventDefault();
  }

  function draw(e) {
    if (!drawing) return;
    const p = getPos(e);
    ctx.strokeStyle = '#14110f';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    e.preventDefault();
  }

  function endDraw() {
    drawing = false;
  }

  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', draw);
  window.addEventListener('mouseup', endDraw);
  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', draw, { passive: false });
  canvas.addEventListener('touchend', endDraw);

  document.getElementById('c-sig-clear-btn').addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasSignature = false;
    signBtn.disabled = true;
  });

  signBtn.addEventListener('click', () => {
    if (!hasSignature) return;
    requestSign(canvas.toDataURL('image/png'));
  });
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  setUpSignaturePad();

  document.getElementById('q-accept-btn').addEventListener('click', () => requestDecision('accepted'));
  document.getElementById('q-decline-btn').addEventListener('click', () => requestDecision('rejected'));
  document.getElementById('q-download-btn').addEventListener('click', () => window.print());
  document.getElementById('c-download-btn').addEventListener('click', () => window.print());

  document.getElementById('identity-confirm-btn').addEventListener('click', submitIdentity);
  document.getElementById('identity-cancel-btn').addEventListener('click', () => {
    pendingAction = null;
    closeIdentityModal();
  });
  document.getElementById('identity-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitIdentity();
  });
});
