const fs = require('fs');
const jwt = require('jsonwebtoken');

// Openssl read - base64 47
const secretKey = "HF1414345acdbABx/5scZerwdsf456543/mAtCsfsdfds27Bt";

const payload = {
  user: 'pp81718',
  role: 'admin',
  // exp = Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 30 * 2) // Two month in Sec
};

const token = jwt.sign(payload, secretKey, { expiresIn: '2m' });

fs.writeFileSync('jqt-secret-key.txt', secretKey);
console.log('Generated JQT Token', token);
