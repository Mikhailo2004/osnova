// currency.js
const axios = require('axios');

class CurrencyConverter {
  constructor() {
    this.exchangeRates = new Map();
    this.currencies = {
      USD: { flag: '🇺🇸', name: 'Долар США' },
      EUR: { flag: '🇪🇺', name: 'Євро' },
      UAH: { flag: '🇺🇦', name: 'Гривня' },
      GBP: { flag: '🇬🇧', name: 'Фунт стерлінгів' },
      PLN: { flag: '🇵🇱', name: 'Злотий' },
      CZK: { flag: '🇨🇿', name: 'Чеська крона' },
      JPY: { flag: '🇯🇵', name: 'Єна' },
      CNY: { flag: '🇨🇳', name: 'Юань' },
      TRY: { flag: '🇹🇷', name: 'Турецька ліра' },
      EGP: { flag: '🇪🇬', name: 'Єгипетський фунт' }
    };
    this.lastUpdate = null;
    this.updateInterval = 2 * 60 * 60 * 1000; // 2 години
  }

  async initialize() {
    console.log('💱 Ініціалізація конвертера валют...');
    await this.updateExchangeRates();
    
    // Автоматичне оновлення курсів
    setInterval(() => {
      this.updateExchangeRates().catch(error => {
        console.error('❌ Помилка автооновлення курсів:', error);
      });
    }, this.updateInterval);
    
    console.log('✅ Конвертер валют готовий до роботи');
  }

  async updateExchangeRates() {
    try {
      console.log('📡 Отримання курсів валют від НБУ...');
      
      const response = await axios.get('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json', {
        timeout: 10000 // 10 секунд таймаут
      });

      if (response.data && Array.isArray(response.data)) {
        this.exchangeRates.clear();
        
        // Додаємо USD як базову валюту
        this.exchangeRates.set('USD', { rate: 1, change: 0 });
        
        // Обробляємо отримані курси
        response.data.forEach(item => {
          if (this.currencies[item.cc]) {
            this.exchangeRates.set(item.cc, {
              rate: parseFloat(item.rate),
              change: parseFloat(item.rate) - parseFloat(item.rate_prev || item.rate)
            });
          }
        });
        
        this.lastUpdate = new Date();
        console.log(`✅ Курси валют оновлено: ${this.exchangeRates.size} валют`);
        console.log(`📅 Останнє оновлення: ${this.lastUpdate.toLocaleString('uk-UA')}`);
      } else {
        throw new Error('Неправильний формат даних від НБУ');
      }
    } catch (error) {
      console.error('❌ Помилка оновлення курсів:', error.message);
      this.setBackupRates();
    }
  }

  setBackupRates() {
    // Резервні курси на випадок недоступності API
    const backupRates = {
      USD: { rate: 1, change: 0 },
      EUR: { rate: 0.915, change: 0.005 },
      UAH: { rate: 39.5, change: -0.2 },
      GBP: { rate: 0.782, change: 0.011 },
      PLN: { rate: 3.95, change: -0.03 },
      CZK: { rate: 23.0, change: 0.8 },
      JPY: { rate: 150.0, change: -0.1 },
      CNY: { rate: 7.2, change: 0.4 },
      TRY: { rate: 32.0, change: -1.2 },
      EGP: { rate: 31.0, change: 0.7 }
    };

    this.exchangeRates.clear();
    Object.entries(backupRates).forEach(([currency, data]) => {
      this.exchangeRates.set(currency, data);
    });
    
    this.lastUpdate = new Date();
    console.log('⚠️ Використовуються резервні курси валют');
  }

  convert(amount, fromCurrency, toCurrency) {
    if (!this.exchangeRates.has(fromCurrency) || !this.exchangeRates.has(toCurrency)) {
      throw new Error('Непідтримувана валюта');
    }

    const fromRate = this.exchangeRates.get(fromCurrency).rate;
    const toRate = this.exchangeRates.get(toCurrency).rate;
    
    const uahAmount = amount * fromRate;
    const result = uahAmount / toRate;
    
    return {
      amount: amount,
      fromCurrency: fromCurrency,
      toCurrency: toCurrency,
      result: result,
      rate: toRate / fromRate,
      date: this.lastUpdate
    };
  }

  getCurrencies() {
    return this.currencies;
  }

  getExchangeRates() {
    return this.exchangeRates;
  }

  isSupported(currency) {
    return this.currencies.hasOwnProperty(currency);
  }

  formatResult(conversion) {
    const fromCurrency = this.currencies[conversion.fromCurrency];
    const toCurrency = this.currencies[conversion.toCurrency];
    
    const formatAmount = (amount) => {
      if (amount >= 1000000) {
        return (amount / 1000000).toFixed(2) + 'M';
      } else if (amount >= 1000) {
        return (amount / 1000).toFixed(2) + 'K';
      } else {
        return amount.toFixed(2);
      }
    };
    
    return {
      from: `${fromCurrency.flag} ${formatAmount(conversion.amount)} ${conversion.fromCurrency}`,
      to: `${toCurrency.flag} ${formatAmount(conversion.result)} ${conversion.toCurrency}`,
      rate: `1 ${conversion.fromCurrency} = ${conversion.rate.toFixed(4)} ${conversion.toCurrency}`,
      reverseRate: `1 ${conversion.toCurrency} = ${(1 / conversion.rate).toFixed(4)} ${conversion.fromCurrency}`,
      date: conversion.date ? conversion.date.toLocaleDateString('uk-UA') : 'Невідомо'
    };
  }

  formatExchangeRatesForAmount(amount = 100) {
    const rates = this.getExchangeRates();
    const currencies = this.getCurrencies();
    let message = `📊 Курси обміну для ${amount} USD:\n\n`;
    
    const usdRate = rates.get('USD')?.rate || 1;
    
    rates.forEach((rateData, currency) => {
      if (currency !== 'USD') {
        const currencyInfo = currencies[currency];
        const rate = (rateData.rate / usdRate) * amount;
        const formattedRate = rate >= 1 ? rate.toFixed(2) : rate.toFixed(4);
        const change = rateData.change ? ` (${rateData.change > 0 ? '+' : ''}${rateData.change.toFixed(2)}%)` : '';
        message += `${currencyInfo.flag} ${currency}: ${formattedRate}${change}\n`;
      }
    });
    
    message += `\n📅 Останнє оновлення: ${this.lastUpdate ? this.lastUpdate.toLocaleString('uk-UA') : 'Невідомо'}`;
    message += `\n💡 Курси від Національного банку України`;
    
    return message;
  }

  formatExchangeRatesForCurrency(baseCurrency, amount = 100) {
    const rates = this.getExchangeRates();
    const currencies = this.getCurrencies();
    
    if (!rates.has(baseCurrency)) {
      throw new Error('Непідтримувана валюта');
    }
    
    let message = `📊 Курси обміну для ${amount} ${baseCurrency}:\n\n`;
    
    const baseRate = rates.get(baseCurrency).rate;
    
    rates.forEach((rateData, currency) => {
      if (currency !== baseCurrency) {
        const currencyInfo = currencies[currency];
        const rate = (rateData.rate / baseRate) * amount;
        const formattedRate = rate >= 1 ? rate.toFixed(2) : rate.toFixed(4);
        const change = rateData.change ? ` (${rateData.change > 0 ? '+' : ''}${rateData.change.toFixed(2)}%)` : '';
        message += `${currencyInfo.flag} ${currency}: ${formattedRate}${change}\n`;
      }
    });
    
    message += `\n📅 Останнє оновлення: ${this.lastUpdate ? this.lastUpdate.toLocaleString('uk-UA') : 'Невідомо'}`;
    message += `\n💡 Курси від Національного банку України`;
    
    return message;
  }

  async startAutoUpdate() {
    // Оновлення при старті
    await this.updateExchangeRates();
    // Автоматичне оновлення з інтервалом
    setInterval(async () => {
      try {
        await this.updateExchangeRates();
      } catch (error) {
        console.error('❌ Помилка автооновлення курсів:', error);
      }
    }, this.updateInterval);
  }
}

module.exports = CurrencyConverter; 