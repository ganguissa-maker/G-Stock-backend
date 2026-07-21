// Enveloppe une route async : toute erreur/rejet est transmis à next(err)
// au lieu de faire planter tout le process Node (comportement par défaut d'Express 4).
module.exports = function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
