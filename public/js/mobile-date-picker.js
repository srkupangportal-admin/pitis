(function () {
  const mobileQuery = window.matchMedia('(max-width: 700px), (pointer: coarse)');
  if (!mobileQuery.matches) return;

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let activeInput = null;
  let visibleMonth = null;
  let selectedDate = null;

  const dialog = document.createElement('div');
  dialog.className = 'portal-date-picker-backdrop hidden';
  dialog.innerHTML = `
    <section class="portal-date-picker" role="dialog" aria-modal="true" aria-labelledby="portalDatePickerTitle">
      <div class="portal-date-picker-heading">
        <div><small>Select date</small><strong id="portalDatePickerTitle"></strong></div>
        <button type="button" class="portal-date-picker-close" aria-label="Close date picker">&times;</button>
      </div>
      <div class="portal-date-picker-month-nav">
        <button type="button" data-previous-month aria-label="Previous month">&#8249;</button>
        <strong data-month-label></strong>
        <button type="button" data-next-month aria-label="Next month">&#8250;</button>
      </div>
      <div class="portal-date-picker-weekdays"></div>
      <div class="portal-date-picker-days"></div>
      <div class="portal-date-picker-actions">
        <button type="button" class="btn secondary" data-today>Today</button>
        <button type="button" class="btn secondary" data-clear>Clear</button>
        <span></span>
        <button type="button" class="btn secondary" data-cancel>Cancel</button>
        <button type="button" class="btn" data-confirm>Select</button>
      </div>
    </section>`;
  document.body.appendChild(dialog);

  const title = dialog.querySelector('#portalDatePickerTitle');
  const monthLabel = dialog.querySelector('[data-month-label]');
  const weekdays = dialog.querySelector('.portal-date-picker-weekdays');
  const days = dialog.querySelector('.portal-date-picker-days');
  weekdayNames.forEach(name => {
    const item = document.createElement('span');
    item.textContent = name;
    weekdays.appendChild(item);
  });

  function parseIso(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function iso(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function display(date) {
    return date ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'No date selected';
  }

  function isOutsideLimits(date) {
    const value = iso(date);
    return (activeInput.min && value < activeInput.min) || (activeInput.max && value > activeInput.max);
  }

  function render() {
    monthLabel.textContent = `${monthNames[visibleMonth.getMonth()]} ${visibleMonth.getFullYear()}`;
    title.textContent = display(selectedDate);
    days.innerHTML = '';
    const first = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
    const leading = (first.getDay() + 6) % 7;
    const start = new Date(first);
    start.setDate(first.getDate() - leading);
    const todayIso = iso(new Date());

    for (let index = 0; index < 42; index += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = date.getDate();
      button.dataset.date = iso(date);
      button.className = 'portal-date-picker-day';
      if (date.getMonth() !== visibleMonth.getMonth()) button.classList.add('outside-month');
      if (button.dataset.date === todayIso) button.classList.add('today');
      if (selectedDate && button.dataset.date === iso(selectedDate)) button.classList.add('selected');
      if (isOutsideLimits(date)) button.disabled = true;
      button.onclick = () => {
        selectedDate = date;
        render();
      };
      days.appendChild(button);
    }
  }

  function close() {
    dialog.classList.add('hidden');
    document.body.classList.remove('portal-date-picker-open');
    activeInput = null;
  }

  function open(input) {
    if (!input || input.disabled || input.readOnly) return;
    activeInput = input;
    selectedDate = parseIso(input.value);
    const basis = selectedDate || parseIso(input.min) || new Date();
    visibleMonth = new Date(basis.getFullYear(), basis.getMonth(), 1);
    render();
    dialog.classList.remove('hidden');
    document.body.classList.add('portal-date-picker-open');
    dialog.querySelector('.portal-date-picker-close').focus();
  }

  dialog.querySelector('[data-previous-month]').onclick = () => {
    visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1);
    render();
  };
  dialog.querySelector('[data-next-month]').onclick = () => {
    visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
    render();
  };
  dialog.querySelector('[data-today]').onclick = () => {
    const today = new Date();
    if (isOutsideLimits(today)) return;
    selectedDate = today;
    visibleMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    render();
  };
  dialog.querySelector('[data-confirm]').onclick = () => {
    if (!activeInput || !selectedDate || isOutsideLimits(selectedDate)) return;
    activeInput.value = iso(selectedDate);
    activeInput.dispatchEvent(new Event('input', { bubbles: true }));
    activeInput.dispatchEvent(new Event('change', { bubbles: true }));
    close();
  };
  dialog.querySelector('[data-clear]').onclick = () => {
    if (!activeInput) return;
    activeInput.value = '';
    activeInput.dispatchEvent(new Event('input', { bubbles: true }));
    activeInput.dispatchEvent(new Event('change', { bubbles: true }));
    close();
  };
  dialog.querySelector('[data-cancel]').onclick = close;
  dialog.querySelector('.portal-date-picker-close').onclick = close;
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !dialog.classList.contains('hidden')) close(); });

  document.addEventListener('pointerdown', event => {
    const input = event.target.closest && event.target.closest('input[type="date"]');
    if (!input || input.disabled || input.readOnly) return;
    event.preventDefault();
    open(input);
  }, true);
  document.addEventListener('click', event => {
    const input = event.target.closest && event.target.closest('input[type="date"]');
    if (!input || input.disabled || input.readOnly) return;
    event.preventDefault();
    if (dialog.classList.contains('hidden')) open(input);
  }, true);
  document.addEventListener('keydown', event => {
    const input = event.target.closest && event.target.closest('input[type="date"]');
    if (input && !input.disabled && !input.readOnly && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      open(input);
    }
  }, true);
})();
