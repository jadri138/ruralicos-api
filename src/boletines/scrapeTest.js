const { scrapeBoaHoy } = require('./boaScraper');

(async () => {
  const data = await scrapeBoaHoy();

  console.log('ENCONTRADOS HOY:', data.length);
  console.log(data.slice(0, 10)); // ver los 10 primeros
})();
