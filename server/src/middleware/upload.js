const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;

// Define upload directory
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

// Create uploads directory if it doesn't exist
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Configure storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    // Generate unique filename: {date}_{timestamp}_{sanitized-original}.ext
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const timestamp = Date.now();
    const sanitizedName = file.originalname
      .replace(/[^a-zA-Z0-9.-]/g, '_') // Replace special chars with underscore
      .replace(/_{2,}/g, '_'); // Replace multiple underscores with single
    const filename = `${date}_${timestamp}_${sanitizedName}`;
    cb(null, filename);
  }
});

// File filter for validation
const fileFilter = function (req, file, cb) {
  // Allowed MIME types
  const allowedMimeTypes = [
    'image/png',
    'image/jpg',
    'image/jpeg',
    'application/pdf'
  ];

  // Allowed extensions
  const allowedExtensions = ['.png', '.jpg', '.jpeg', '.pdf'];
  const ext = path.extname(file.originalname).toLowerCase();

  // Double validation: MIME type + extension
  if (allowedMimeTypes.includes(file.mimetype) && allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Tipo de archivo no válido. Solo se permiten PNG, JPG, JPEG y PDF.'), false);
  }
};

// Configure multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Middleware for single file upload
const uploadSingle = upload.single('attachment');

// Error handling wrapper
const uploadSingleWithErrorHandling = (req, res, next) => {
  uploadSingle(req, res, function (err) {
    if (err instanceof multer.MulterError) {
      // Multer-specific errors
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'El archivo excede el tamaño máximo permitido de 5MB.'
        });
      }
      return res.status(400).json({
        success: false,
        message: `Error al subir el archivo: ${err.message}`
      });
    } else if (err) {
      // Custom errors (like file type validation)
      return res.status(400).json({
        success: false,
        message: err.message
      });
    }
    // No error, continue to next middleware
    next();
  });
};

// Magic-byte sniffing - defends against a renamed exe/script being uploaded
// as `.pdf`. Reads the first 8 bytes and compares against the file signatures
// for the four formats we accept.
async function validateFileSignature(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(8);
    const { bytesRead } = await fh.read(buf, 0, 8, 0);
    if (bytesRead < 4) return false;
    // PDF: "%PDF"
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return true;
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
        buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return true;
    // JPG: FF D8 FF
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
    return false;
  } finally {
    await fh.close();
  }
}

module.exports = {
  uploadSingle: uploadSingleWithErrorHandling,
  validateFileSignature,
  UPLOAD_DIR
};
