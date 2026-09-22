(() => {
  'use strict';

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  let deferredInstallPrompt = null;

  function installButtons() {
    return Array.from(document.querySelectorAll('[data-pwa-install]'));
  }

  function setInstallButtonVisibility(show) {
    installButtons().forEach((button) => {
      button.hidden = !show;
      button.setAttribute('aria-hidden', show ? 'false' : 'true');
    });
  }

  function showIosInstallHelp() {
    const existing = document.getElementById('pwaInstallHelp');
    if (existing) {
      existing.hidden = false;
      return;
    }
    const help = document.createElement('aside');
    help.id = 'pwaInstallHelp';
    help.className = 'pwa-install-help';
    help.setAttribute('role', 'status');
    help.innerHTML = '<strong>Add SRK Portal to this device</strong><span>In Safari, tap Share, then Add to Home Screen.</span><button type="button" aria-label="Close install instructions">Close</button>';
    help.querySelector('button').addEventListener('click', () => help.remove());
    document.body.appendChild(help);
  }

  async function install() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(() => null);
      deferredInstallPrompt = null;
      setInstallButtonVisibility(false);
      return;
    }
    if (isIos) showIosInstallHelp();
  }

  function prepare() {
    if (!isStandalone && isIos) setInstallButtonVisibility(true);
    installButtons().forEach((button) => button.addEventListener('click', install));

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      deferredInstallPrompt = event;
      setInstallButtonVisibility(true);
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      setInstallButtonVisibility(false);
    });

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch(() => {
          // The portal continues normally when offline support is unavailable.
        });
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', prepare);
  else prepare();
})();
