(function () {
  var modal = document.getElementById("teacherProgressWelcome");
  if (!modal) return;

  var dialog = modal.querySelector(".teacher-progress-dialog");
  var closeButtons = modal.querySelectorAll("[data-progress-close]");
  var focusableSelector = "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";
  var previousFocus = document.activeElement;

  function closeModal() {
    modal.classList.add("is-closing");
    window.setTimeout(function () {
      modal.remove();
      document.body.classList.remove("teacher-progress-open");
      if (previousFocus && previousFocus.focus) previousFocus.focus();
    }, 180);
  }

  closeButtons.forEach(function (button) {
    button.addEventListener("click", closeModal);
  });

  modal.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== "Tab") return;
    var focusable = Array.prototype.slice.call(modal.querySelectorAll(focusableSelector));
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  document.body.classList.add("teacher-progress-open");
  if (dialog) dialog.focus();
}());
