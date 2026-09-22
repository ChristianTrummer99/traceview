(() => {
  const search = document.getElementById('session-search');
  const source = document.getElementById('source-filter');
  const pinned = document.getElementById('bookmarks-only');
  const rows = [...document.querySelectorAll('tbody tr')];
  const update = () => {
    let count = 0;
    for (const row of rows) {
      row.hidden = !(row.dataset.search.includes(search.value.trim().toLowerCase()) && (!source.value || row.dataset.source === source.value) && (!pinned.checked || row.dataset.bookmarked === 'true'));
      if (!row.hidden) count++;
    }
    document.getElementById('count').textContent = `${count} of ${rows.length} sessions`;
    document.getElementById('no-results').hidden = count > 0;
  };
  [search, source, pinned].forEach(el => el.addEventListener('input', update));
  update();
})();
