// Phase 0.6: consolidates the page/pageSize -> skip/take arithmetic that was
// previously copy-pasted, byte-for-byte identical, across ~22 list
// endpoints. Behavior is unchanged from every one of those call sites:
// pageSize defaults to 20 and is capped at 100; page defaults to 1 and is
// floored at 1.
function parsePagination(query, { defaultPageSize = 20, maxPageSize = 100 } = {}) {
  const { page = '1', pageSize = String(defaultPageSize) } = query || {};
  const take = Math.min(parseInt(pageSize, 10) || defaultPageSize, maxPageSize);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  return { page: Number(page) || 1, pageSize: take, skip, take };
}

module.exports = { parsePagination };
