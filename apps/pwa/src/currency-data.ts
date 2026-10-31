// Pure data (no imports) so tests can import it. See currencies.ts for the helpers.
/**
 * Middle East & North Africa currencies - the Arab League states plus Iran, Israel and Turkey (and Malta/Cyprus use EUR,
 * which is in the international list). Pinned at the top of the currency dropdown.
 */
export const MENA_CURRENCIES = [
  "AED", // United Arab Emirates dirham
  "BHD", // Bahraini dinar
  "DJF", // Djiboutian franc
  "DZD", // Algerian dinar
  "EGP", // Egyptian pound
  "ILS", // Israeli new shekel (also used in the Palestinian territories)
  "IQD", // Iraqi dinar
  "IRR", // Iranian rial
  "JOD", // Jordanian dinar (also used in the West Bank)
  "KMF", // Comorian franc
  "KWD", // Kuwaiti dinar
  "LBP", // Lebanese pound
  "LYD", // Libyan dinar
  "MAD", // Moroccan dirham (also Western Sahara)
  "MRU", // Mauritanian ouguiya
  "OMR", // Omani rial
  "QAR", // Qatari riyal
  "SAR", // Saudi riyal
  "SDG", // Sudanese pound
  "SOS", // Somali shilling
  "SYP", // Syrian pound
  "TND", // Tunisian dinar
  "TRY", // Turkish lira
  "YER", // Yemeni rial
] as const;

/** Active ISO 4217 alphabetic codes (the international list). MENA codes above are a subset. */
export const ALL_CURRENCIES = [
  "AED","AFN","ALL","AMD","ANG","AOA","ARS","AUD","AWG","AZN","BAM","BBD","BDT","BGN","BHD","BIF","BMD","BND","BOB","BRL","BSD","BTN","BWP","BYN","BZD",
  "CAD","CDF","CHF","CLP","CNY","COP","CRC","CUP","CVE","CZK","DJF","DKK","DOP","DZD","EGP","ERN","ETB","EUR","FJD","FKP","GBP","GEL","GHS","GIP","GMD","GNF",
  "GTQ","GYD","HKD","HNL","HTG","HUF","IDR","ILS","INR","IQD","IRR","ISK","JMD","JOD","JPY","KES","KGS","KHR","KMF","KPW","KRW","KWD","KYD","KZT","LAK","LBP",
  "LKR","LRD","LSL","LYD","MAD","MDL","MGA","MKD","MMK","MNT","MOP","MRU","MUR","MVR","MWK","MXN","MYR","MZN","NAD","NGN","NIO","NOK","NPR","NZD","OMR","PAB",
  "PEN","PGK","PHP","PKR","PLN","PYG","QAR","RON","RSD","RUB","RWF","SAR","SBD","SCR","SDG","SEK","SGD","SHP","SLE","SOS","SRD","SSP","STN","SVC","SYP","SZL",
  "THB","TJS","TMT","TND","TOP","TRY","TTD","TWD","TZS","UAH","UGX","USD","UYU","UZS","VES","VND","VUV","WST","XAF","XCD","XCG","XOF","XPF","YER","ZAR","ZMW","ZWG",
  // Withdrawn or non-circulating codes still found in ICU/CLDR data and in older records - included so nothing is missing:
  "CUC","HRK","SLL","XDR","XSU","ZWL",
] as const;

