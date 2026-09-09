(function () {
  function getSubmitter(event) {
    return event.submitter || document.activeElement || null;
  }

  function getAction(form, submitter) {
    return (submitter && submitter.getAttribute && submitter.getAttribute("formaction")) ||
      form.getAttribute("action") ||
      window.location.href;
  }

  function getMethod(form, submitter) {
    return String(
      (submitter && submitter.getAttribute && submitter.getAttribute("formmethod")) ||
      form.getAttribute("method") ||
      "get"
    ).toUpperCase();
  }

  function appendSubmitter(payload, submitter) {
    if (!submitter || !submitter.name || payload.has(submitter.name)) return;
    payload.append(submitter.name, submitter.value || "");
  }

  function parseFeedback(urlValue, doc) {
    try {
      var url = new URL(urlValue, window.location.origin);
      var error = url.searchParams.get("error");
      var success = url.searchParams.get("success");
      if (error) return { message: error, isError: true };
      if (success) return { message: success, isError: false };
    } catch (_err) {}

    var errorEl = doc && doc.querySelector(".error");
    if (errorEl && errorEl.textContent.trim()) {
      return { message: errorEl.textContent.trim(), isError: true };
    }
    return null;
  }

  function ensureStatus(main) {
    var status = main.querySelector("[data-async-form-status]");
    if (status) return status;
    status = document.createElement("section");
    status.className = "card";
    status.setAttribute("data-async-form-status", "1");
    status.style.display = "none";
    status.innerHTML = "<div></div>";
    main.insertBefore(status, main.firstChild);
    return status;
  }

  function showStatus(main, feedback) {
    if (!feedback || !feedback.message) return;
    var status = ensureStatus(main);
    var message = status.querySelector("div") || status;
    message.textContent = feedback.message;
    message.className = feedback.isError ? "error" : "muted";
    status.style.display = "block";
  }

  function getDetailKey(detail) {
    if (!detail) return "";
    if (detail.id) return "id:" + detail.id;
    if (detail.dataset && detail.dataset.asyncStateKey) return "key:" + detail.dataset.asyncStateKey;
    return "";
  }

  function collectOpenDetails(root) {
    var open = {};
    Array.prototype.slice.call(root.querySelectorAll("details[open]")).forEach(function (detail) {
      var key = getDetailKey(detail);
      if (key) open[key] = true;
    });
    return open;
  }

  function restoreOpenDetails(root, open) {
    Array.prototype.slice.call(root.querySelectorAll("details")).forEach(function (detail) {
      var key = getDetailKey(detail);
      if (key && open[key]) detail.setAttribute("open", "");
    });
  }

  function replaceMainFromHtml(html, responseUrl, previousScroll) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(html, "text/html");
    var nextMain = doc.querySelector("main");
    var currentMain = document.querySelector("main");
    if (!nextMain || !currentMain) return false;

    var openDetails = collectOpenDetails(currentMain);
    currentMain.innerHTML = nextMain.innerHTML;
    restoreOpenDetails(currentMain, openDetails);
    showStatus(currentMain, parseFeedback(responseUrl, doc));
    runScriptsAfterMain(doc);

    try {
      var url = new URL(responseUrl, window.location.origin);
      if (url.origin === window.location.origin && url.pathname !== window.location.pathname) {
        window.history.pushState({}, "", url.pathname + url.search + url.hash);
      }
    } catch (_err) {}

    window.requestAnimationFrame(function () {
      window.scrollTo(previousScroll.x, previousScroll.y);
      window.requestAnimationFrame(function () {
        window.scrollTo(previousScroll.x, previousScroll.y);
      });
    });
    return true;
  }

  function runScriptsAfterMain(doc) {
    var nextMain = doc.querySelector("main");
    if (!nextMain || !doc.body) return;
    Array.prototype.slice.call(doc.body.querySelectorAll("script")).forEach(function (script) {
      if (script.src || !script.textContent.trim()) return;
      if (!(nextMain.compareDocumentPosition(script) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
      var replacement = document.createElement("script");
      replacement.text = script.textContent;
      document.body.appendChild(replacement);
      document.body.removeChild(replacement);
    });
  }

  function bindAsyncForms(root) {
    Array.prototype.slice.call((root || document).querySelectorAll("form[data-async-form]")).forEach(function (form) {
      if (form.dataset.asyncFormBound === "1") return;
      form.dataset.asyncFormBound = "1";
      form.addEventListener("submit", function (event) {
        var submitter = getSubmitter(event);
        if (submitter && submitter.hasAttribute && submitter.hasAttribute("data-async-skip")) return;

        event.preventDefault();

        var action = getAction(form, submitter);
        var method = getMethod(form, submitter);
        var payload = new FormData(form);
        appendSubmitter(payload, submitter);
        var previousScroll = { x: window.scrollX || 0, y: window.scrollY || 0 };
        var buttons = Array.prototype.slice.call(form.querySelectorAll("button, input[type='submit']"));
        buttons.forEach(function (button) { button.disabled = true; });

        fetch(action, {
          method: method,
          body: method === "GET" ? undefined : payload,
          headers: { Accept: "text/html,application/json" },
          credentials: "same-origin"
        })
          .then(function (response) {
            var contentType = String(response.headers.get("content-type") || "");
            if (contentType.indexOf("application/json") >= 0) {
              return response.json().then(function (data) {
                if (!response.ok || data.success === false) {
                  throw new Error(data.error || data.message || "Update failed");
                }
                showStatus(document.querySelector("main"), { message: data.message || "Updated", isError: false });
              });
            }
            return response.text().then(function (html) {
              if (!replaceMainFromHtml(html, response.url || action, previousScroll)) {
                throw new Error("Update completed, but the page could not be refreshed in place");
              }
              bindAsyncForms(document);
            });
          })
          .catch(function (error) {
            showStatus(document.querySelector("main"), { message: error.message || "Update failed", isError: true });
            window.scrollTo(previousScroll.x, previousScroll.y);
          })
          .finally(function () {
            buttons.forEach(function (button) { button.disabled = false; });
          });
      });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    bindAsyncForms(document);
  });
  window.portalBindAsyncForms = bindAsyncForms;
})();
