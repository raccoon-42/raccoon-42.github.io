const toggleBtn = document.getElementById('theme-toggle');
const root = document.documentElement;

function setIcon(isDark) {
  if (toggleBtn) toggleBtn.innerHTML = isDark ? '🌙' : '☀️';
}

// Resolve the theme: saved preference wins, otherwise follow the OS.
const savedTheme = localStorage.getItem('theme');
let isDark;
if (savedTheme === 'dark') {
  isDark = true;
} else if (savedTheme === 'light') {
  isDark = false;
} else {
  isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
}

root.classList.toggle('dark-theme', isDark);
setIcon(isDark);

if (toggleBtn) {
  toggleBtn.addEventListener('click', () => {
    const nowDark = root.classList.toggle('dark-theme');
    localStorage.setItem('theme', nowDark ? 'dark' : 'light');
    setIcon(nowDark);
  });
}

// Mobile hamburger menu
const navToggle = document.getElementById('nav-toggle');
const navMenu = document.getElementById('nav-menu');
if (navToggle && navMenu) {
  function closeMenu() {
    navMenu.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');
  }
  navToggle.addEventListener('click', () => {
    const open = navMenu.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  navMenu.addEventListener('click', (e) => {
    if (e.target.closest('a')) closeMenu();
  });
  // tap/click anywhere outside the menu (and not on the toggle) closes it
  document.addEventListener('click', (e) => {
    if (!navMenu.classList.contains('open')) return;
    if (navMenu.contains(e.target) || navToggle.contains(e.target)) return;
    closeMenu();
  });
}

