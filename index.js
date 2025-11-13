const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.json(message: 'Esta sera la proxima web de Ruralicos! 🚜);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('API lista');
});
