// Kept for clarity even though express-async-errors patches rejections globally -
// explicit wrapping makes controller intent obvious and stays safe if that patch
// is ever removed.
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = asyncRoute;
