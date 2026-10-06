// Renders a template body's {{placeholders}} against a flat variables
// object. Deliberately simple string substitution (no template engine, no
// eval) - templates are tenant-authored text, never executable code.
function renderTemplate(body, variables = {}) {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    const value = variables[key];
    return value === undefined || value === null ? match : String(value);
  });
}

// The set of placeholders a template body references - used for the
// "variable/placeholder preview" requirement so staff can see what a
// template needs before sending.
function extractPlaceholders(body) {
  const matches = body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g);
  return [...new Set([...matches].map((m) => m[1]))];
}

module.exports = { renderTemplate, extractPlaceholders };
