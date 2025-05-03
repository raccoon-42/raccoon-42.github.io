const toggleBtn = document.getElementById('theme-toggle');
const root = document.documentElement;

const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'dark') {
  root.classList.add('dark-theme');
} else if (savedTheme === 'light') {
  root.classList.remove('dark-theme');
} else {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (prefersDark) root.classList.add('dark-theme');
}

toggleBtn.addEventListener('click', () => {
  toggleBtn.innerHTML = toggleBtn.innerHTML === '🌙' ? '☀️' : '🌙';
  const isDark = root.classList.toggle('dark-theme');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
});