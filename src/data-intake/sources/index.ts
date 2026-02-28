// This file registers all built-in data sources for the Nexus system.
// It imports and registers each data source with the registry so they are available for use.

import { registerDataSource } from "../registry.js";

import { cryptoSource } from "./crypto.js";
import { coinlayerSource } from "./crypto-coinlayer.js";
import { cryptoCompareSource } from "./crypto-cryptocompare.js";
import { cryptoCoingeckoMultiSource } from "./crypto-coingecko-multi.js";
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
import { birdBatchSource } from "./social-bird-batch.js";
import { canadaCPISource } from "./macro-canada-cpi.js";
import { googleNewsSource } from "./news-google.js";
import { hackerNewsSource } from "./news-hackernews.js";
import { ontarioHydroSource } from "./utilities-ontario-hydro.js";
import { ontario511TrafficSource } from "./traffic-511ontario.js";
import { barrieAqiSource } from "./weather-aqi-barrie.js";

// Registers all built-in data sources with the data intake registry.
// This function should be called during system initialization to make all
// standard data sources (crypto, stocks, weather, markets, etc.) available.
export function registerBuiltInSources(): void {
  registerDataSource(googleNewsSource);
  registerDataSource(hackerNewsSource);
  registerDataSource(cryptoSource);
  registerDataSource(coinlayerSource);
  registerDataSource(cryptoCompareSource);
  registerDataSource(cryptoCoingeckoMultiSource);
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
  registerDataSource(birdBatchSource); // Batch Twitter/X fetching
  registerDataSource(canadaCPISource); // Canadian inflation data
  registerDataSource(ontarioHydroSource);
  registerDataSource(ontario511TrafficSource);
  registerDataSource(barrieAqiSource);
}
