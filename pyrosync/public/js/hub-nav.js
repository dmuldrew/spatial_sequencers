// Centralized responsive navigation controller (modern-web-guidance `navbar` pattern)
if (typeof HTMLElement !== 'undefined' && !Object.hasOwn(HTMLElement.prototype, 'popover')) {
  import('https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js').catch(() => {});
}

export function initHubNavbar() {
  const header = document.querySelector('.hub-header');
  const inner = header?.querySelector('.hub-header-inner');
  const menu = document.getElementById('site-menu');
  if (!header || !inner || !menu) return;

  // Normalize relative paths if PyroSync is opened at root /index.html instead of /pyrosync/
  const path = window.location.pathname;
  if (document.getElementById('panel-spiral-view') && !path.includes('/pyrosync/')) {
    menu.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (href === '../') a.setAttribute('href', './hub/');
      else if (href.startsWith('../')) a.setAttribute('href', `./${href.slice(3)}`);
    });
    const brand = header.querySelector('.hub-brand');
    if (brand && brand.getAttribute('href') === '../') brand.setAttribute('href', './hub/');
  }

  let lastCollapsedWidth = 0;

  function syncNavLayout() {
    const wasOpen = menu.matches(':popover-open, .\\:popover-open');
    header.classList.add('is-measuring', 'is-wide');
    menu.removeAttribute('popover');

    const fitsInline = inner.scrollWidth <= inner.clientWidth;
    if (fitsInline) {
      header.classList.add('is-wide');
      menu.removeAttribute('popover');
      lastCollapsedWidth = 0;
    } else {
      header.classList.remove('is-wide');
      menu.setAttribute('popover', 'auto');
      lastCollapsedWidth = header.clientWidth;
      if (wasOpen && typeof menu.showPopover === 'function') {
        try {
          menu.showPopover();
        } catch (_) {}
      }
    }

    requestAnimationFrame(() => {
      header.classList.remove('is-measuring');
    });
  }

  function updateActiveNavLink() {
    const curPath = window.location.pathname;
    const hash = window.location.hash;
    const links = Array.from(menu.querySelectorAll('a[data-exp]'));
    let activeExp = 'hub';

    if (curPath.endsWith('/fly.html')) {
      activeExp = 'fire-flight';
    } else if (curPath.includes('/space-jukebox')) {
      activeExp = 'space-jukebox';
    } else if (curPath.includes('/midwest/map.html')) {
      activeExp = 'iowa-map';
    } else if (curPath.includes('/pyrosync') || document.getElementById('panel-spiral-view')) {
      if (hash === '#iowa-map' || hash === '#tab-iowa') activeExp = 'iowa-map';
      else if (hash === '#flyby' || hash === '#tab-flyby') activeExp = 'pyrosat-flyby';
      else activeExp = 'spiral';
    }

    links.forEach((link) => {
      if (link.dataset.exp === activeExp) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  }

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      const isWide = header.classList.contains('is-wide');
      if (isWide || header.clientWidth > lastCollapsedWidth) {
        syncNavLayout();
      }
    });
    ro.observe(header);
    ro.observe(menu);
  }

  window.addEventListener('hashchange', updateActiveNavLink);
  window.addEventListener('pyrosync:tabchange', updateActiveNavLink);

  // Close mobile popover when a same-page hash link is clicked
  menu.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link) return;
    if (!header.classList.contains('is-wide') && typeof menu.hidePopover === 'function') {
      try {
        menu.hidePopover();
      } catch (_) {}
    }
    setTimeout(updateActiveNavLink, 0);
  });

  syncNavLayout();
  updateActiveNavLink();
}

initHubNavbar();
