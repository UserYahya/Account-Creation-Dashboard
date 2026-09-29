// Express 4 does not catch rejected promises from async handlers
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Absolute URL for QR codes and links shown to participants
function absoluteUrl(config, req, pathname) {
  const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}${pathname}`;
}

function textLines(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function notFound(res, message = 'পাতাটি খুঁজে পাওয়া যায়নি।') {
  return res.status(404).render('error', { title: 'পাওয়া যায়নি', heading: 'পাতাটি পাওয়া যায়নি', message });
}

function sendCSV(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(csv, 'utf-8'));
}

module.exports = { asyncHandler, absoluteUrl, textLines, notFound, sendCSV };
