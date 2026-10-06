// Phase 0.6: consolidates the identical dateRange() helper that was
// copy-pasted across 5 report modules. Behavior unchanged: `to` defaults to
// now, `from` defaults to `defaultDays` days before `to`.
function dateRange(query, defaultDays = 30) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - defaultDays * 86400000);
  return { from, to };
}

module.exports = { dateRange };
