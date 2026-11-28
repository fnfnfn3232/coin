(function (root) {
  "use strict";
  const nameKey = value => String(value || "").toLowerCase().replace(/[^a-z0-9\uac00-\ud7a3]/g, "");
  const aliases = {
    MLK: ["milk", "milkalliance"],
    FRAX: ["frax", "fraxfinance", "fraxprevfxs"],
    CC: ["canton", "cantonnetwork"], B3: ["b3", "b3base"],
    ADA: ["ada", "cardano"], XLM: ["lumen", "stellar", "stellarlumens"],
    SKY: ["sky", "skyprotocol"], MORPHO: ["morpho", "morphotoken", "morpholabs"],
    RENDER: ["render", "rendertoken", "rendernetwork"], "1INCH": ["1inch", "1inchnetwork"],
    PROM: ["prom", "prometeus"], ZRX: ["0x", "0xprotocol", "0xproject"],
    CKB: ["ckb", "nervos", "nervosnetwork"], MOCA: ["mocanetwork", "mocacoin"],
    ONG: ["ong", "ontologygas"], SNT: ["status", "statusnetwork", "statusnetworktoken"],
    AUCTION: ["bounce", "auction", "bouncetoken", "bounceauction"], IQ: ["iq", "iqwiki"],
    CBK: ["cobak", "cobaktoken"], FOLD: ["theinterfold", "interfold"], MIRA: ["mira", "miranetwork"],
    ORDER: ["orderly", "orderlynetwork"], USDT: ["tether", "tetherusdt"],
    TFUEL: ["tfuel", "thetafuel"], RON: ["ronin", "roninnetwork"], WAXP: ["waxp", "wax"],
    US: ["talus", "talusnetwork"], BILL: ["billions", "billionsnetwork"], SIX: ["six", "sixnetwork"],
    HUNT: ["hunt", "hunttown"],
    PCI: ["paycoin", "payprotocolpaycoin"], DEBIT: ["teller", "tellerfinance"],
  };
  const chains = { ETH: "ethereum", ERC20: "ethereum", BSC: "bsc", BEP20: "bsc", ARBEVM: "arbitrum",
    ARBITRUM: "arbitrum", BASEEVM: "base", BASE: "base", SOL: "solana", SOLANA: "solana" };
  const explorerChains = { "etherscan.io": "ethereum", "bscscan.com": "bsc", "arbiscan.io": "arbitrum",
    "basescan.org": "base", "optimistic.etherscan.io": "optimism", "polygonscan.com": "polygon", "snowtrace.io": "avalanche" };

  // Content aliases do not relax exchange price/contract identity checks.
  const contentNames = {
    "0G": ["0g", "zerogravity"], AERO: ["aerodrome", "aerodromefinance"],
    ALLO: ["allora", "alloranetwork"], ATM: ["atleticodemadridfantoken"],
    AUCTION: ["auction", "bounce", "bouncetoken", "bouncegovernancetoken"], AVA: ["ava", "travala"],
    BR: ["bedrock", "bedrocktoken"], BSB: ["blockstreet", "blockstreettoken"], C: ["chainbase", "chainbasetoken"],
    CFX: ["conflux", "confluxnetwork"], CORE: ["core", "coredao"], CRV: ["curve", "curvedaotoken"],
    CYBER: ["cyber", "cyberconnect"], DEEP: ["deepbook", "deepbookprotocol"], GMT: ["greenmetaversetoken", "stepn"],
    GPS: ["goplus", "goplussecurity"], HAEDAL: ["haedal", "haedalprotocol"], HBAR: ["hedera", "hederahashgraph"],
    ICNT: ["impossiblecloudnetwork", "impossiblecloudnetworktoken"], IMX: ["immutable", "immutablex"],
    KITE: ["kite", "kiteai"], KMNO: ["kamino", "kaminofinance"], KNC: ["kybernetwork", "kybernetworkcrystalv2"],
    MANTA: ["manta", "mantanetwork"], MEGA: ["mega", "megaeth"], OGN: ["origintoken", "originprotocol"],
    ORDI: ["ordi", "ordinals"], PUFFER: ["puffer", "pufferfinance"], RE: ["re", "reprotocol"],
    SKL: ["skale", "skalenetwork"], SNX: ["synthetix", "synthetixnetworktoken"], SSV: ["ssvtoken", "ssvnetwork"],
    STRK: ["starknet", "starknettoken"], SUSHI: ["sushi", "sushiswap"], TRB: ["tellor", "tellortributes"],
    USDC: ["usdc", "usdcoin"], USDE: ["usdethena", "ethenausde"],
    VIRTUAL: ["virtualprotocol", "virtualsprotocol"],
    WLFI: ["worldlibertyfinancial", "월리파", "월드파이"],
    // Confirmed branding-only changes; see the official sources in server-auth/README.md.
    AVNT: ["avantis", "veranta"], NFT: ["apenft", "ainft"], STRAX: ["stratis", "xertra"],
    GRAM: ["gram", "gramprevtoncoin", "toncoin"], TON: ["gram", "gramprevtoncoin", "toncoin"],
    AKT: ["akash", "akashnetwork"], ANKR: ["ankr", "ankrnetwork"], BAND: ["band", "bandprotocol"],
    CRO: ["cronos", "cryptocomcoin"], EIGEN: ["eigenlayer", "eigencloud"], ETC: ["ethereumclassic", "etherclassic"],
    ETH: ["ethereum", "ether"], FET: ["fetchai", "artificialsuperintelligencealliance", "artificialsuperintelligence"],
    FLOKI: ["floki", "flokiinu"], GLM: ["golem", "golemnetwork"], INJ: ["injective", "injectiveprotocol"],
    LISTA: ["lista", "listadao"], MTL: ["metal", "metaldao"], NEWT: ["newton", "newtonprotocol"],
    ONDO: ["ondo", "ondofinance"], RAD: ["radicle", "radworks"], RECALL: ["recall", "recallnetwork"],
    REQ: ["request", "requestnetwork"], USDG: ["globaldollar", "usdglobaldollar"],
    VTHO: ["vethor", "vethortoken"], WAXL: ["axelar", "wrappedaxelar"], WCT: ["walletconnect", "walletconnecttoken"],
  };
  const contentNameKey = value => nameKey(String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, ""));
  function contentAliases(row) {
    const key = String(row?.symbol || "").toUpperCase(), name = contentNameKey(row?.englishName || row?.name);
    const group = [...new Set([...(contentNames[key] || []), ...(aliases[key] || [])])];
    return group.includes(name) ? group : [];
  }
  function contentAsset(row, canonical, context = {}) {
    const key = String(row?.symbol || "").toUpperCase();
    if (!/^[A-Z0-9]{1,40}$/.test(key)) return "";
    const ownName = row.englishName || row.name || key, targetName = canonical?.englishName;
    let conflict = row.assetIdentityConflict === true || canonical?.assetIdentityConflict === true;
    if (row.marketIdentityVerified === true && canonical?.marketIdentityVerified === true && row.coingeckoId && canonical.coingeckoId
      && row.coingeckoId !== canonical.coingeckoId) conflict = true;
    const ownContracts = contracts(row, context.info, context.baseBoard), targetContracts = contracts(canonical);
    for (const chain of new Set(ownContracts.map(item => item[0]))) {
      const target = targetContracts.filter(item => item[0] === chain);
      if (target.length && !ownContracts.some(item => item[0] === chain && target.some(other => other[1] === item[1]))) conflict = true;
    }
    const same = targetName && !conflict
      && (contentNameKey(ownName) === contentNameKey(targetName)
        || contentNameKey(ownName) === contentNameKey(key)
        || contentAliases({ ...row, englishName: ownName }).includes(contentNameKey(targetName))
        || matches(row, { ...canonical, symbol: key }, context));
    const asset = nativeContentAsset(key, same ? targetName : ownName), name = asset.split(":")[1];
    if (["UP", "UP2"].includes(key) && name === "superform") return "UP:superform";
    if (key === "META2" && name === "metadao") return "META:metadao";
    if (["GRAM", "TON"].includes(key) && ["gram", "gramprevtoncoin", "toncoin"].includes(name)) return "GRAM:gram";
    return asset;
  }
  function nativeContentAsset(key, value) {
    if (!/^[A-Z0-9]{1,40}$/.test(key)) return "";
    let name = String(value || key).normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 100) || key.toLowerCase();
    if (key === "SKY" && ["sky", "skyprotocol"].includes(name)) name = "skyprotocol";
    return `${key}:${name}`;
  }
  function contentTarget(row, canonical, context = {}) {
    const key = String(row?.symbol || "").toUpperCase();
    const matched = canonical?.englishName && matches(row, { ...canonical, symbol: key }, context);
    return nativeContentAsset(key, matched ? canonical.englishName : row?.englishName || key);
  }

  function symbol(row, board) {
    const value = String(row?.compareSymbol || row?.symbol || "").toUpperCase();
    // Superform uses UP2 on Upbit and SUPERFORM on Gate; keep native quote IDs intact.
    // https://www.gate.com/announcements/article/50627
    if (nameKey(row?.englishName) === "superform"
      && ((board === "upbit" && value === "UP2") || (board === "gateio" && value === "SUPERFORM"))) return "UP";
    // Domestic META2 is MetaDAO; domestic META is the unrelated Metadium.
    if (["upbit", "bithumb"].includes(board) && value === "META2" && nameKey(row?.englishName) === "metadao") return "META";
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
      const sharedKorean = [row.koreanName, ...(row.nameKeys || [])].map(nameKey).filter(value => /[\uac00-\ud7a3]/.test(value))
        .some(value => [candidate.koreanName, ...(candidate.nameKeys || [])].map(nameKey).includes(value));
      return ["upbit", "bithumb"].includes(context.baseBoard) && domesticName
        && (candidate.comparisonIdentity?.officialName === true || sharedKorean);
    }
    const names = item => [item.englishName, ...(item.nameKeys || [])].map(nameKey).filter(value => value && value !== nameKey(item.symbol));
    const ownNames = names(row);
    return ownNames.length > 0 && names(candidate).some(value => ownNames.includes(value));
  }

  function uniqueCatalog(source, symbols) {
    if (!Array.isArray(source) || !(symbols instanceof Set) || symbols.size > 2000) throw new Error("invalid_identity_candidates");
    const assets = {};
    const ambiguous = new Set();
    for (const row of source) {
      const symbol = String(row?.symbol || "").toUpperCase();
      const name = String(row?.name || "").trim();
      if (!symbols.has(symbol) || row.is_active !== true || !/^[A-Z0-9]{1,40}$/.test(symbol)
        || !name || name.length > 120 || !/^[a-z0-9-]{1,120}$/.test(row.id || "")) continue;
      if (assets[symbol] && assets[symbol][1] !== row.id) ambiguous.add(symbol);
      assets[symbol] = [name, row.id];
    }
    for (const symbol of ambiguous) delete assets[symbol];
    return assets;
  }

  const api = Object.freeze({ matches, symbol, contracts, uniqueCatalog, contentAsset, contentAliases, contentTarget });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BlockscopeComparisonIdentity = api;
})(globalThis);
