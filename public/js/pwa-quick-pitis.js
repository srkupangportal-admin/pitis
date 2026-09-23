(() => {
  'use strict';
  const state = { reasons: [], students: [], action: '', amount: 0, installPrompt: null };
  const byId = (id) => document.getElementById(id);
  const classSelect = byId('classSelect');
  const studentSelect = byId('studentSelect');
  const reasonSelect = byId('reasonSelect');
  const customToggle = byId('useCustomReason');
  const customReason = byId('customReason');
  const reviewButton = byId('reviewButton');
  const statusMessage = byId('statusMessage');
  const dialog = byId('confirmDialog');
  const scanDialog = byId('scanDialog');
  let qrScanner = null;
  let scannerActive = false;
  let scanProcessing = false;

  async function request(url, options) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: { 'content-type': 'application/json', ...((options || {}).headers || {}) }
    });
    if (response.redirected && new URL(response.url).pathname === '/login') {
      window.location.href = `/login?next=${encodeURIComponent('/pwa')}`;
      throw new Error('Sign in is required.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  function option(select, value, label) {
    const item = document.createElement('option');
    item.value = String(value);
    item.textContent = label;
    select.appendChild(item);
  }

  function showStatus(message, type = '') {
    statusMessage.textContent = message;
    statusMessage.className = `status-message ${type}`.trim();
  }

  function selectedStudent() {
    return state.students.find((student) => Number(student.id) === Number(studentSelect.value));
  }

  function updateStudentCard() {
    const student = selectedStudent();
    byId('studentCard').hidden = !student;
    if (!student) return updateReviewState();
    byId('studentName').textContent = student.nickname;
    byId('studentFullName').textContent = '';
    byId('studentTotal').textContent = `${Number(student.total_points || 0)} PITIS`;
    byId('studentPhoto').src = student.photo_src || '/images/student-placeholder.svg';
    updateReviewState();
  }

  function refreshReasons() {
    reasonSelect.innerHTML = '';
    option(reasonSelect, '', state.action ? 'Select reason' : 'Choose PITIS first');
    const type = state.action === 'award' ? 'positive' : state.action === 'deduct' ? 'negative' : '';
    state.reasons.filter((reason) => reason.reason_type === type).forEach((reason) => option(reasonSelect, reason.id, reason.reason + (Number(reason.is_default) === 1 ? ' · Default' : '')));
    reasonSelect.disabled = !type || customToggle.checked;
    updateReviewState();
  }

  function updateReviewState() {
    const hasReason = customToggle.checked ? customReason.value.trim().length > 0 : Number(reasonSelect.value) > 0;
    reviewButton.disabled = !(Number(classSelect.value) && Number(studentSelect.value) && state.action && state.amount && hasReason);
  }

  async function rememberClass() {
    await request('/pwa/api/preferences', {
      method: 'POST',
      body: JSON.stringify({ class_id: Number(classSelect.value) || null })
    });
  }

  async function loadStudents(remember = false) {
    state.students = [];
    studentSelect.innerHTML = '';
    byId('studentCard').hidden = true;
    const classId = Number(classSelect.value);
    if (remember) {
      try { await rememberClass(); } catch (error) { showStatus(error.message, 'error'); }
    }
    if (!classId) {
      option(studentSelect, '', 'Select a class first');
      studentSelect.disabled = true;
      return updateReviewState();
    }
    studentSelect.disabled = true;
    option(studentSelect, '', 'Loading students…');
    try {
      const data = await request(`/pwa/api/classes/${classId}/students`);
      state.students = data.students || [];
      studentSelect.innerHTML = '';
      option(studentSelect, '', 'Select student');
      state.students.forEach((student) => option(studentSelect, student.id, `${student.nickname} — ${student.total_points} PITIS`));
      studentSelect.disabled = false;
    } catch (error) {
      studentSelect.innerHTML = '';
      option(studentSelect, '', 'Unable to load students');
      showStatus(error.message, 'error');
    }
    updateReviewState();
  }

  async function stopScanner() {
    if (!qrScanner || !scannerActive) return;
    scannerActive = false;
    await qrScanner.stop().catch(() => {});
    await qrScanner.clear().catch(() => {});
  }

  async function selectScannedStudent(qrText) {
    if (scanProcessing) return;
    scanProcessing = true;
    byId('scanStatus').textContent = 'Checking student…';
    try {
      const data = await request('/pwa/api/scan', { method: 'POST', body: JSON.stringify({ qr_text: qrText }) });
      await stopScanner();
      classSelect.value = String(data.student.class_id);
      await loadStudents(true);
      studentSelect.value = String(data.student.id);
      updateStudentCard();
      scanDialog.close();
      showStatus(`${data.student.nickname} selected by QR.`, 'success');
    } catch (error) {
      byId('scanStatus').textContent = error.message;
    } finally {
      scanProcessing = false;
    }
  }

  async function startScanner() {
    if (!window.Html5Qrcode) {
      byId('scanStatus').textContent = 'QR scanner is unavailable. Paste the QR text below.';
      return;
    }
    byId('scanStatus').textContent = 'Starting camera…';
    qrScanner = qrScanner || new Html5Qrcode('pwaQrReader');
    try {
      await qrScanner.start(
        { facingMode: { ideal: 'environment' } },
        { fps: 10, qrbox: { width: 240, height: 240 }, aspectRatio: 1.333334 },
        (decodedText) => selectScannedStudent(decodedText),
        () => {}
      );
      scannerActive = true;
      byId('scanStatus').textContent = 'Point the camera at a student QR code.';
    } catch (error) {
      byId('scanStatus').textContent = 'Camera could not open. Allow camera permission or paste QR text below.';
    }
  }

  byId('scanStudent').addEventListener('click', () => {
    scanDialog.showModal();
    startScanner();
  });
  byId('closeScanner').addEventListener('click', async () => {
    await stopScanner();
    scanDialog.close();
  });
  scanDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    stopScanner().finally(() => scanDialog.close());
  });
  byId('manualQrForm').addEventListener('submit', (event) => {
    event.preventDefault();
    selectScannedStudent(byId('manualQrText').value.trim());
  });

  document.querySelectorAll('.number-button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.number-button').forEach((item) => item.classList.remove('selected'));
      button.classList.add('selected');
      state.action = button.dataset.action;
      state.amount = Number(button.dataset.amount);
      refreshReasons();
    });
  });

  classSelect.addEventListener('change', () => loadStudents(true));
  studentSelect.addEventListener('change', updateStudentCard);
  reasonSelect.addEventListener('change', updateReviewState);
  customReason.addEventListener('input', updateReviewState);
  customToggle.addEventListener('change', () => {
    customReason.hidden = !customToggle.checked;
    reasonSelect.disabled = customToggle.checked || !state.action;
    if (customToggle.checked) customReason.focus();
    updateReviewState();
  });

  reviewButton.addEventListener('click', () => {
    const student = selectedStudent();
    const selectedReason = customToggle.checked ? customReason.value.trim() : reasonSelect.options[reasonSelect.selectedIndex].textContent;
    const verb = state.action === 'award' ? 'Award' : 'Deduct';
    byId('confirmSummary').textContent = `${verb} ${state.amount} PITIS ${state.action === 'award' ? 'to' : 'from'} ${student.nickname} for “${selectedReason}”?`;
    dialog.showModal();
  });

  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'confirm') return;
    const submit = byId('submitTransaction');
    submit.disabled = true;
    showStatus('Saving PITIS…');
    try {
      const payload = {
        class_id: Number(classSelect.value),
        student_id: Number(studentSelect.value),
        action: state.action,
        amount: state.amount,
        reason_id: customToggle.checked ? null : Number(reasonSelect.value),
        custom_reason: customToggle.checked ? customReason.value.trim() : ''
      };
      const data = await request('/pwa/api/transactions', { method: 'POST', body: JSON.stringify(payload) });
      const student = selectedStudent();
      student.total_points = data.student.total_points;
      updateStudentCard();
      if (data.reason && !state.reasons.some((reason) => Number(reason.id) === Number(data.reason.id))) state.reasons.push(data.reason);
      const sign = data.transaction.points > 0 ? '+' : '';
      showStatus(`${data.student.name}: ${sign}${data.transaction.points} PITIS saved.`, 'success');
      customReason.value = '';
      customToggle.checked = false;
      customReason.hidden = true;
      refreshReasons();
    } catch (error) {
      showStatus(error.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });

  byId('enableNotifications').addEventListener('click', async () => {
    try {
      await window.PortalNotifications.enable();
      showStatus('Push notifications enabled on this device.', 'success');
      byId('enableNotifications').textContent = 'Notifications enabled';
    } catch (error) {
      showStatus(error.message, 'error');
    }
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    byId('installApp').hidden = false;
  });
  byId('installApp').addEventListener('click', async () => {
    if (!state.installPrompt) {
      const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
      alert(isIos
        ? 'To install PITIS, open this page in Safari, tap Share, then tap Add to Home Screen.'
        : 'Open your browser menu and choose Install app or Add to Home screen. If PITIS is already installed, open it from your home screen.');
      return;
    }
    state.installPrompt.prompt();
    await state.installPrompt.userChoice.catch(() => null);
    state.installPrompt = null;
    byId('installApp').hidden = true;
  });

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (!isStandalone) {
    byId('installApp').hidden = false;
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(() => {});

  request('/pwa/api/bootstrap').then((data) => {
    state.reasons = data.reasons || [];
    classSelect.innerHTML = '';
    option(classSelect, '', 'Select class');
    (data.classes || []).forEach((cls) => option(classSelect, cls.id, `${cls.name} (${cls.student_count})`));
    if (data.selectedClassId && classSelect.querySelector(`option[value="${Number(data.selectedClassId)}"]`)) {
      classSelect.value = String(data.selectedClassId);
      loadStudents(false);
    }
  }).catch((error) => showStatus(error.message, 'error'));
})();
