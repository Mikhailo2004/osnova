document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('theme-toggle');
  const stored = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (stored) {
    document.body.classList.toggle('light', stored === 'light');
  } else {
    document.body.classList.toggle('light', !prefersDark);
  }
  toggle.checked = document.body.classList.contains('light');

  toggle.addEventListener('change', () => {
    document.body.classList.toggle('light', toggle.checked);
    localStorage.setItem('theme', toggle.checked ? 'light' : 'dark');
  });

  const cryptoIds = {
    btc: 'bitcoin',
    eth: 'ethereum',
    usdt: 'tether',
    bnb: 'binancecoin',
    doge: 'dogecoin'
  };

  function updatePrices() {
    const ids = Object.values(cryptoIds).join(',');
    fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`)
      .then(r => r.json())
      .then(data => {
        for (const [key, id] of Object.entries(cryptoIds)) {
          const price = data[id]?.usd;
          if (price) {
            const el = document.querySelector(`#${key} .price`);
            if (el) el.textContent = `$${price}`;
          }
        }
      })
      .catch(() => {});
  }

  updatePrices();
  setInterval(updatePrices, 60000);
});
