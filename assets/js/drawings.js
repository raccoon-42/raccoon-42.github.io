// Click-to-enlarge lightbox for the drawings gallery.
(function () {
    const lb = document.getElementById('lightbox');
    if (!lb) return;
    const img = lb.querySelector('img');
    const cap = lb.querySelector('figcaption');

    function open(src, title) {
        img.src = src;
        img.alt = title || 'Drawing by Ali Ozkaya';
        cap.textContent = title || '';
        lb.classList.add('open');
        document.body.style.overflow = 'hidden';
    }

    function close() {
        lb.classList.remove('open');
        img.src = '';
        document.body.style.overflow = '';
    }

    document.querySelectorAll('.art').forEach(function (fig) {
        function go() { open(fig.dataset.full, fig.dataset.title || ''); }
        fig.addEventListener('click', go);
        fig.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
        });
    });

    lb.addEventListener('click', function (e) {
        if (e.target === lb || e.target.classList.contains('close')) close();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') close();
    });
})();
