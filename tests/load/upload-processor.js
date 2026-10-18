const FormData = require('form-data');
const crypto = require('crypto');

/**
 * Artillery Custom Processor for Multipart Audio Chunk Uploads (#371)
 *
 * Attaches a dynamic multipart/form-data payload with a unique fileId
 * and valid audio chunk buffer before each chunk upload request.
 */
function setupUploadChunk(requestParams, context, ee, next) {
  const fileId = `artillery-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  context.vars.fileId = fileId;

  const form = new FormData();
  form.append('fileId', fileId);
  form.append('chunkIndex', '0');

  // Dummy valid audio buffer with ID3 header
  const buf = Buffer.alloc(64 * 1024, 0);
  buf.write('ID3', 0, 3, 'ascii');
  buf[3] = 0x03;
  buf[4] = 0x00;

  form.append('chunk', buf, {
    filename: 'chunk_0.mp3',
    contentType: 'audio/mpeg',
  });

  requestParams.body = form;
  requestParams.headers = {
    ...requestParams.headers,
    ...form.getHeaders(),
  };

  return next();
}

module.exports = {
  setupUploadChunk,
};
