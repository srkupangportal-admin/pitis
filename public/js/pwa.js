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

  function showInstallHelp() {
    const existing = document.getElementById('pwaInstallHelp');
    if (existing) {
      existing.hidden = false;
      return;
    }
    const help = document.createElement('aside');
    help.id = 'pwaInstallHelp';
    help.className = 'pwa-install-help';
    help.setAttribute('role', 'status');
    help.innerHTML = isIos
      ? '<strong>Add PITIS to this device</strong><span>In Safari, tap Share, then Add to Home Screen.</span><button type="button" aria-label="Close install instructions">Close</button>'
      : '<strong>Install PITIS</strong><span>Open your browser menu and choose Install app or Add to Home screen. If PITIS is already installed, open it from your home screen.</span><button type="button" aria-label="Close install instructions">Close</button>';
    help.querySelector('button').addEventListener('click', () => help.remove());
    document.body.appendChild(help);
  }

  async function install() {
    if (deferredInstallPrompt) {
      try {
        await deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        setInstallButtonVisibility(false);
        return;
      } catch {
        deferredInstallPrompt = null;
      }
    }
    showInstallHelp();
  }

  function prepare() {
    if (!isStandalone) setInstallButtonVisibility(true);
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
