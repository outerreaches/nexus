// This file registers all built-in data sources for the Nexus system.
// It imports and registers each data source with the registry so they are available for use.

import { registerDataSource } from "../registry.js";

import { cryptoSource } from "./crypto.js";
import { coinlayerSource } from "./crypto-coinlayer.js";
import { cryptoCompareSource } from "./crypto-cryptocompare.js";
import { kalshiSource } from "./markets-kalshi.js";
import { polymarketSource } from "./markets-polymarket.js";
import { metalsSource } from "./metals.js";
import { rssSource } from "./rss.js";
import { stocksSource } from "./stocks.js";
import { marketstackSource } from "./stocks-marketstack.js";
import { twelveDataSource } from "./stocks-twelvedata.js";
import { yahooStocksSource } from "./stocks-yahoo.js";
import { weatherSource } from "./weather.js";
import { birdSource } from "./social-bird.js";
import { canadaCPISource } from "./macro-canada-cpi.js";

// Registers all built-in data sources with the data intake registry.
// This function should be called during system initialization to make all
// standard data sources (crypto, stocks, weather, markets, etc.) available.
export function registerBuiltInSources(): void {
  registerDataSource(cryptoSource);
  registerDataSource(coinlayerSource);
  registerDataSource(cryptoCompareSource);
  registerDataSource(kalshiSource);
  registerDataSource(polymarketSource);
  registerDataSource(metalsSource);
  registerDataSource(rssSource);
  registerDataSource(stocksSource);
  registerDataSource(marketstackSource);
  registerDataSource(twelveDataSource);
  registerDataSource(yahooStocksSource);
  registerDataSource(weatherSource);
  registerDataSource(birdSource);
  registerDataSource(canadaCPISource); // Canadian inflation data
}
