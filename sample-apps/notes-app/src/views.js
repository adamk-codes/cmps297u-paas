const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Single server-rendered page. The banner shows which database and image are serving the page,
// which is what makes the recovery URL easy to tell apart from the live app in a demo.
export function renderHome({ notes, count, database, config }) {
  const base = config.basePath
  const isRecovery = database.includes('_restore_')
  const rows = notes
    .map(
      (n) => `<tr><td>${n.id}</td><td>${escapeHtml(n.title)}</td><td>${escapeHtml(n.author)}</td>
        <td>${escapeHtml(new Date(n.created_at).toISOString().slice(0, 16).replace('T', ' '))}</td></tr>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(config.appName)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 900px; padding: 0 1rem; color: #1f2933; }
  .banner { padding: .75rem 1rem; border-radius: 8px; background: ${isRecovery ? '#fff4e5' : '#e8f4fd'}; margin-bottom: 1.5rem; }
  .banner code { font-size: .95em; }
  table { width: 100%; border-collapse: collapse; font-size: .92rem; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid #e4e7eb; }
  form { display: flex; gap: .5rem; margin: 1rem 0 1.5rem; flex-wrap: wrap; }
  input { padding: .45rem .6rem; border: 1px solid #cbd2d9; border-radius: 6px; }
  input[name=title] { flex: 1; min-width: 200px; }
  button { padding: .45rem 1rem; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }
</style>
</head>
<body>
<h1>${escapeHtml(config.appName)}${isRecovery ? ' (recovery copy)' : ''}</h1>
<div class="banner">
  <strong>${count}</strong> notes &middot; database <code>${escapeHtml(database)}</code>
  &middot; image <code>${escapeHtml(config.imageTag)}</code>
</div>
<form method="post" action="${escapeHtml(base)}/notes">
  <input name="title" placeholder="New note title" required maxlength="200">
  <input name="author" placeholder="Author" maxlength="80">
  <button type="submit">Add note</button>
</form>
<table>
<thead><tr><th>#</th><th>Title</th><th>Author</th><th>Created (UTC)</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="4">No notes.</td></tr>'}
</tbody>
</table>
<p>Showing the latest ${notes.length} of ${count}. JSON: <a href="${escapeHtml(base)}/api/notes">${escapeHtml(base)}/api/notes</a>
&middot; <a href="${escapeHtml(base)}/api/stats">stats</a> &middot; <a href="${escapeHtml(base)}/healthz">healthz</a></p>
</body>
</html>`
}
