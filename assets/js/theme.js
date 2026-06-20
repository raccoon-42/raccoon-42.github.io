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
