(function (root) {
  "use strict";
  const nameKey = value => String(value || "").toLowerCase().replace(/[^a-z0-9\uac00-\ud7a3]/g, "");
  const aliases = {
    MLK: ["milk", "milkalliance"],
    FRAX: ["frax", "fraxfinance", "fraxprevfxs"],
    CC: ["canton", "cantonnetwork"], B3: ["b3", "b3base"],
  };
  const chains = { ETH: "ethereum", ERC20: "ethereum", BSC: "bsc", BEP20: "bsc", ARBEVM: "arbitrum",
    ARBITRUM: "arbitrum", BASEEVM: "base", BASE: "base", SOL: "solana", SOLANA: "solana" };
  const explorerChains = { "etherscan.io": "ethereum", "bscscan.com": "bsc", "arbiscan.io": "arbitrum",
    "basescan.org": "base", "optimistic.etherscan.io": "optimism", "polygonscan.com": "polygon", "snowtrace.io": "avalanche" };

  function symbol(row, board) {
    const value = String(row?.compareSymbol || row?.symbol || "").toUpperCase();
    // Binance's BEAMX is the gaming BEAM token, not the privacy coin BEAM.
    // https://www.binance.com/en/support/announcement/detail/c8705b752c7c47fc814a373a0f1856ee
    return value === "BEAMX" && ["binance", "gateio"].includes(board) && nameKey(row.englishName) === "beam" ? "BEAM" : value;
  }

  function contracts(row, info, board) {
    const result = [];
    for (const item of row?.comparisonIdentity?.contracts || []) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const chain = chains[String(item[0]).toUpperCase()] || String(item[0]).toLowerCase();
      const address = /^0x[0-9a-f]{40}$/i.test(item[1]) ? item[1].toLowerCase() : String(item[1]);
      if (chain && address && !/^0x0{40}$/.test(address)) result.push([chain, address]);
    }
    const source = info?.sources?.[board];
    if (source && (!source.englishName || nameKey(source.englishName) === nameKey(row.englishName))) {
      for (const value of [source.explorer, source.explorerUrl].flat().filter(Boolean)) {
        try {
          const url = new URL(value);
          const chain = explorerChains[url.hostname.replace(/^www\./, "")];
          const address = url.pathname.match(/\/(?:token|address)\/(0x[0-9a-f]{40})(?:\/|$)/i)?.[1];
          if (chain && address && !/^0x0{40}$/i.test(address)) result.push([chain, address.toLowerCase()]);
        } catch (_error) { /* An absent explorer is not identity evidence. */ }
      }
    }
    return result;
  }

  function matches(row, candidate, context = {}) {
    const aSymbol = symbol(row, context.baseBoard);
    if (!aSymbol || aSymbol !== symbol(candidate, context.referenceBoard)) return false;
    if (row.assetIdentityConflict === true || candidate.assetIdentityConflict === true) return false;
    if (aSymbol === "FRAX" && candidate.paprikaId === "frax-frax") return false;
    if (aSymbol === "BEAM" && ["gateio", "binance"].includes(context.referenceBoard)
      && String(candidate.symbol).toUpperCase() === "BEAM") return false;
    const ownContracts = contracts(row, context.info, context.baseBoard);
    const foreignContracts = contracts(candidate, context.referenceInfo, context.referenceBoard);
    let sharedContract = false;
    for (const chain of new Set(ownContracts.map(item => item[0]))) {
      const a = ownContracts.filter(item => item[0] === chain).map(item => item[1]);
      const b = foreignContracts.filter(item => item[0] === chain).map(item => item[1]);
      if (!b.length) continue;
      if (!a.some(address => b.includes(address))) return false;
      sharedContract = true;
    }
    // marketIdentityVerified belongs to cap/supply provenance, not trade listings.
    if (row.coingeckoId && candidate.coingeckoId && row.marketIdentityVerified === true && candidate.marketIdentityVerified === true) {
      return row.coingeckoId === candidate.coingeckoId;
    }
    if (sharedContract) return true;
    const a = nameKey(row.englishName);
    const b = nameKey(candidate.englishName);
    if (aSymbol === "BEAM" && candidate.symbol === "BEAMX" && ["binance", "gateio"].includes(context.referenceBoard)
      && a === "beam" && b === "beam") return true;
    const group = aliases[aSymbol];
    if (a !== b && group?.includes(a) && group.includes(b)) return true;
    if (a && b) {
      if (a !== b) return false;
      if (a !== nameKey(aSymbol)) return true;
      const domesticName = [row.koreanName, ...(row.nameKeys || [])].some(value => /[\uac00-\ud7a3]/.test(String(value || "")));
      const sharedKorean = (row.nameKeys || []).map(nameKey).filter(value => /[\uac00-\ud7a3]/.test(value))
        .some(value => (candidate.nameKeys || []).map(nameKey).includes(value));
      return ["upbit", "bithumb"].includes(context.baseBoard) && domesticName
        && (candidate.comparisonIdentity?.officialName === true || sharedKorean);
    }
    const names = item => [item.englishName, ...(item.nameKeys || [])].map(nameKey).filter(value => value && value !== nameKey(item.symbol));
    const ownNames = names(row);
    return ownNames.length > 0 && names(candidate).some(value => ownNames.includes(value));
  }

  const api = Object.freeze({ matches, symbol, contracts });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BlockscopeComparisonIdentity = api;
})(globalThis);
