/* =============================================================
   muaban.vin — app.js (Hardened Full Build)
   - Ethers v5 (UMD) already loaded in index.html
   - Chain: Viction Mainnet (chainId 88)
   - Contracts:
       MuabanVND: 0x190FD18820498872354eED9C4C080cB365Cd12E0
       VIN token: 0x941F63807401efCE8afe3C9d88d368bAA287Fac4
   - Pricing: 1 VIN (VND) = (VIC/USDT from Binance × 100) × (USDT/VND from CoinGecko)
   - Notes:
       * Preflight callStatic before sending tx to capture exact revert reasons
       * estimateGas + 20% headroom
       * Robust price fetch with retry + localStorage cache
   ============================================================= */

(function(){
  'use strict';

  // --------------------------- Constants ---------------------------
  const VIC_CHAIN_ID_DEC = 88;
  const VIC_CHAIN_ID_HEX = '0x58';
  const VIC_RPC = 'https://rpc.viction.xyz';
  const EXPLORER = 'https://www.vicscan.xyz';

  const MUABAN_ADDR = '0x190FD18820498872354eED9C4C080cB365Cd12E0';
  const VIN_ADDR    = '0x941F63807401efCE8afe3C9d88d368bAA287Fac4';

  const REG_FEE_WEI_FALLBACK = ethers.BigNumber.from('1000000000000000'); // 0.001 VIN
  const MAX_PRODUCT_SCAN = 200;

  // Pricing endpoints
  const BINANCE_VICUSDT = 'https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT';
  const COINGECKO_USDTVND = 'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd';
  const PRICE_CACHE_KEY = 'vin_vnd_last';
  const PRICE_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2h

  // --------------------------- ABIs (minimal) ---------------------------
  const MUABAN_ABI = [
    { "inputs": [{"internalType":"address","name":"vinToken","type":"address"}], "stateMutability":"nonpayable","type":"constructor" },
    { "anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"user","type":"address"}],"name":"Registered","type":"event" },
    { "inputs": [], "name": "REG_FEE", "outputs":[{"internalType":"uint256","name":"","type":"uint256"}], "stateMutability":"view", "type":"function" },
    { "inputs": [], "name": "payRegistration", "outputs": [], "stateMutability":"nonpayable", "type":"function" },
    { "inputs":[{"internalType":"address","name":"","type":"address"}], "name":"registered", "outputs":[{"internalType":"bool","name":"","type":"bool"}], "stateMutability":"view","type":"function" },

    { "inputs":[
        {"internalType":"string","name":"name","type":"string"},
        {"internalType":"string","name":"descriptionCID","type":"string"},
        {"internalType":"string","name":"imageCID","type":"string"},
        {"internalType":"uint256","name":"priceVND","type":"uint256"},
        {"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},
        {"internalType":"address","name":"payoutWallet","type":"address"},
        {"internalType":"bool","name":"active","type":"bool"}
      ],
      "name":"createProduct",
      "outputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],
      "stateMutability":"nonpayable","type":"function"
    },
    { "inputs":[
        {"internalType":"uint256","name":"pid","type":"uint256"},
        {"internalType":"uint256","name":"priceVND","type":"uint256"},
        {"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},
        {"internalType":"address","name":"payoutWallet","type":"address"},
        {"internalType":"bool","name":"active","type":"bool"}
      ],
      "name":"updateProduct","outputs":[],
      "stateMutability":"nonpayable","type":"function"
    },
    { "inputs":[{"internalType":"uint256","name":"pid","type":"uint256"},{"internalType":"bool","name":"active","type":"bool"}],
      "name":"setProductActive","outputs":[],
      "stateMutability":"nonpayable","type":"function"
    },
    { "inputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],
      "name":"getProduct",
      "outputs":[{
        "components":[
          {"internalType":"uint256","name":"productId","type":"uint256"},
          {"internalType":"address","name":"seller","type":"address"},
          {"internalType":"string","name":"name","type":"string"},
          {"internalType":"string","name":"descriptionCID","type":"string"},
          {"internalType":"string","name":"imageCID","type":"string"},
          {"internalType":"uint256","name":"priceVND","type":"uint256"},
          {"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},
          {"internalType":"address","name":"payoutWallet","type":"address"},
          {"internalType":"bool","name":"active","type":"bool"},
          {"internalType":"uint64","name":"createdAt","type":"uint64"},
          {"internalType":"uint64","name":"updatedAt","type":"uint64"}
        ],
        "internalType":"struct MuabanVND.Product","name":"","type":"tuple"
      }],
      "stateMutability":"view","type":"function"
    },
    { "inputs":[
        {"internalType":"uint256","name":"productId","type":"uint256"},
        {"internalType":"uint256","name":"quantity","type":"uint256"},
        {"internalType":"uint256","name":"vinPerVND","type":"uint256"},
        {"internalType":"string","name":"buyerInfoCipher","type":"string"}
      ],
      "name":"placeOrder", "outputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],
      "stateMutability":"nonpayable","type":"function"
    }
  ];

  const VIN_ABI = [
    {"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"symbol","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transfer","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"address","name":"sender","type":"address"},{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transferFrom","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}
  ];

  // --------------------------- State ---------------------------
  let provider, signer, userAddr;
  let vin, muaban;
  let vinDecimals = 18;

  let vndPerVIN = null;          // number for UI
  let vinPerVNDWeiBI = null;     // BigInt (wei per 1 VND)

  let productsCache = [];

  // --------------------------- DOM ---------------------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const $btnConnect = $('#btnConnect');
  const $btnDisconnect = $('#btnDisconnect');
  const $walletBox = $('#walletBox');
  const $vinBal = $('#vinBalance');
  const $vicBal = $('#vicBalance');
  const $accShort = $('#accountShort');
  const $vinPriceChip = $('#vinPrice');

  const $menuBox = $('#menuBox');
  const $btnRegister = $('#btnRegister');
  const $btnCreate = $('#btnCreate');
  const $btnOrdersBuy = $('#btnOrdersBuy');
  const $btnOrdersSell = $('#btnOrdersSell');

  const $searchInput = $('#searchInput');
  const $btnSearch = $('#btnSearch');
  const $productList = $('#productList');

  // Modals
  const $formCreate = $('#formCreate');
  const $btnSubmitCreate = $('#btnSubmitCreate');
  const $createName = $('#createName');
  const $createIPFS = $('#createIPFS');
  const $createUnit = $('#createUnit');
  const $createPrice = $('#createPrice');
  const $createWallet = $('#createWallet');
  const $createDays = $('#createDays');

  const $formUpdate = $('#formUpdate');
  const $btnSubmitUpdate = $('#btnSubmitUpdate');
  const $updatePid = $('#updatePid');
  const $updatePrice = $('#updatePrice');
  const $updateDays = $('#updateDays');
  const $updateWallet = $('#updateWallet');
  const $updateActive = $('#updateActive');

  const $formBuy = $('#formBuy');
  const $btnSubmitBuy = $('#btnSubmitBuy');
  const $buyName = $('#buyName');
  const $buyAddress = $('#buyAddress');
  const $buyPhone = $('#buyPhone');
  const $buyNote = $('#buyNote');
  const $buyQty = $('#buyQty');
  const $buyInfo = $('#buyProductInfo');
  const $buyTotalVIN = $('#buyTotalVIN');

  // -------------- Utilities --------------
  function short(addr){ return addr ? (addr.slice(0,6)+'…'+addr.slice(-4)) : ''; }
  function toast(msg, type='info'){
    console[type==='error'?'error':(type==='warn'?'warn':'log')]('[muaban]', msg);
    // Optional: hook to a UI toast system.
    if ($vinPriceChip && type==='error'){
      $vinPriceChip.textContent = '⚠️ ' + msg;
    }
  }
  function show(el){ el?.classList.remove('hidden'); }
  function hide(el){ el?.classList.add('hidden'); }
  function lockScroll(){ document.body.classList.add('no-scroll'); }
  function unlockScroll(){ document.body.classList.remove('no-scroll'); }

  function fmtVND(n){
    try{
      return new Intl.NumberFormat('vi-VN').format(n);
    }catch(e){
      return String(n);
    }
  }
  function fmtVIN(weiBN){
    if (!weiBN) return '0';
    const s = ethers.utils.formatUnits(weiBN, 18);
    const [a,b=''] = s.split('.');
    return a + (b? '.'+b.slice(0,6).replace(/0+$/,'') : '');
  }
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
  function escapeAttr(s){ return escapeHtml(s).replace(/"/g, '&quot;'); }

  function toImageUrl(cidOrUrl){
    if (!cidOrUrl) return '';
    if (cidOrUrl.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + cidOrUrl.slice(7);
    if (/^https?:\/\//i.test(cidOrUrl)) return cidOrUrl;
    return 'https://ipfs.io/ipfs/' + cidOrUrl;
  }

  function encodeBuyerInfo(obj){
    const json = JSON.stringify(obj);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    return b64;
  }

  // BigInt helpers
  const ONE_E18 = 1000000000000000000n;
  const ONE_E6  = 1000000n;
  function toScaledInt(strOrNum, scale=ONE_E6){
    const s = String(strOrNum);
    if (!s.includes('.')) return BigInt(Math.round(Number(s))) * scale;
    const [a,b] = s.split('.');
    const bPad = (b+'000000').slice(0,6);
    const ai = BigInt(a||'0');
    const bi = BigInt(bPad);
    return ai*scale + bi;
  }
  function ceilDivBI(a, b){ return (a + b - 1n) / b; }

  // Decode common Ethers/JSON-RPC errors -> readable reason
  function decodeRevertReason(err){
    try{
      const msg = err?.reason || err?.error?.message || err?.data?.message || err?.message || '';
      const known = ['NOT_REGISTERED','PRICE_REQUIRED','DELIVERY_REQUIRED','PAYOUT_WALLET_ZERO','NOT_SELLER'];
      for (const k of known){ if (msg.includes(k)) return k; }
      const m2 = msg.match(/execution reverted:?\\s*([^"]+)/i);
      if (m2) return m2[1].trim();
      return msg.slice(0,160);
    }catch(_){ return 'UNKNOWN_ERROR'; }
  }

  // --------------------------- Ethers init ---------------------------
  async function ensureViction(){
    if (!window.ethereum) return false;
    const chainId = await window.ethereum.request({ method:'eth_chainId' });
    if (chainId === VIC_CHAIN_ID_HEX) return true;
    try{
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: VIC_CHAIN_ID_HEX }]
      });
      return true;
    }catch(err){
      if (err && err.code === 4902){
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: VIC_CHAIN_ID_HEX,
            chainName: 'Viction Mainnet',
            nativeCurrency: { name:'VIC', symbol:'VIC', decimals:18 },
            rpcUrls: [VIC_RPC],
            blockExplorerUrls: [EXPLORER]
          }]
        });
        return true;
      }
      toast('Please switch to Viction.', 'warn');
      return false;
    }
  }

  async function initContracts(){
    vin = new ethers.Contract(VIN_ADDR, VIN_ABI, signer || provider);
    muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer || provider);
    try{ vinDecimals = await vin.decimals(); }catch(e){ vinDecimals = 18; }
  }

  // --------------------------- Pricing (robust) ---------------------------
  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
  async function safeFetchJson(url, timeoutMs=8000){
    const controller = new AbortController();
    const t = setTimeout(()=>controller.abort(), timeoutMs);
    const bust = url.includes('?') ? `&t=${Date.now()%1e7}` : `?t=${Date.now()%1e7}`;
    try{
      const res = await fetch(url + bust, { signal: controller.signal, cache:'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(t); }
  }
  function loadCachedPrice(){
    try{
      const raw = localStorage.getItem(PRICE_CACHE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj.vndPerVIN!=='number') return null;
      return obj;
    }catch(_){ return null; }
  }
  function saveCachedPrice(v){ try{ localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify({ vndPerVIN:v, ts: Date.now() })); }catch(_){ } }

  async function fetchVndPerVINOnce(){
    const [vicJson, cgJson] = await Promise.all([
      safeFetchJson(BINANCE_VICUSDT),
      safeFetchJson(COINGECKO_USDTVND)
    ]);
    const vicUsdtStr = vicJson?.price ?? vicJson?.lastPrice ?? vicJson?.weightedAvgPrice;
    const usdtVndVal = cgJson?.tether?.vnd ?? cgJson?.tether?.VND;
    if (!vicUsdtStr || usdtVndVal == null) throw new Error('Price feed missing');
    const vic_usdt_scaled = toScaledInt(vicUsdtStr, ONE_E6);
    const usdt_vnd_scaled = toScaledInt(usdtVndVal, ONE_E6);
    const vndPerVIN_scaled = (vic_usdt_scaled * 100n * usdt_vnd_scaled) / ONE_E6;
    const vndPerVIN_num = Number(vndPerVIN_scaled) / 1e6;
    if (!isFinite(vndPerVIN_num) || vndPerVIN_num <= 0) throw new Error('Bad calc');
    return vndPerVIN_num;
  }
  async function computeVinPerVNDWei(vndPerVIN_num){
    const scaled = BigInt(Math.round(vndPerVIN_num * 1e6));
    if (scaled <= 0n) throw new Error('scaled=0');
    const numerator = ONE_E18 * ONE_E6; // 1e24
    return numerator / scaled;
  }
  async function refreshPriceChip(){
    try{
      let lastErr;
      for (let i=0;i<3;i++){
        try{
          const vndPerVIN_num = await fetchVndPerVINOnce();
          const vinPerVNDWei = await computeVinPerVNDWei(vndPerVIN_num);
          vndPerVIN = vndPerVIN_num;
          vinPerVNDWeiBI = vinPerVNDWei;
          saveCachedPrice(vndPerVIN_num);
          if ($vinPriceChip){ $vinPriceChip.textContent = `1 VIN = ${fmtVND(Math.floor(vndPerVIN_num))} VND`; }
          return;
        }catch(e){ lastErr = e; await sleep(500 + i*800); }
      }
      const cached = loadCachedPrice();
      if (cached){
        vndPerVIN = cached.vndPerVIN;
        vinPerVNDWeiBI = await computeVinPerVNDWei(vndPerVIN);
        const stale = Date.now() - (cached.ts||0) > PRICE_CACHE_TTL_MS;
        if ($vinPriceChip){
          $vinPriceChip.textContent = `1 VIN = ${fmtVND(Math.floor(vndPerVIN))} VND` + (stale ? ' (cached, stale)' : ' (cached)');
        }
        console.warn('[price] live feed failed, used cache:', lastErr?.message||lastErr);
        return;
      }
      if ($vinPriceChip) $vinPriceChip.textContent = '1 VIN = … VND';
      console.warn('[price] live feed failed, no cache:', lastErr?.message||lastErr);
    }catch(e){
      if ($vinPriceChip) $vinPriceChip.textContent = '1 VIN = … VND';
      console.warn('[price] fatal:', e);
    }
  }

  // --------------------------- Wallet & balances ---------------------------
  async function refreshBalances(){
    if (!provider || !userAddr) return;
    try{
      const [vinBalRaw, vicBalRaw] = await Promise.all([
        vin.balanceOf(userAddr),
        provider.getBalance(userAddr)
      ]);
      if ($vinBal) $vinBal.textContent = 'VIN: ' + fmtVIN(vinBalRaw);
      if ($vicBal) $vicBal.textContent = 'VIC: ' + fmtVIN(vicBalRaw);
    }catch(e){ toast('Không đọc được số dư.', 'warn'); }
  }

  async function connect(){
    if (!window.ethereum) return toast('Không tìm thấy ví. Hãy cài MetaMask.', 'warn');
    const ok = await ensureViction();
    if (!ok) return;
    provider = new ethers.providers.Web3Provider(window.ethereum, 'any');
    await provider.send('eth_requestAccounts', []);
    signer = provider.getSigner();
    userAddr = await signer.getAddress();
    await initContracts();
    hide($btnConnect);
    show($walletBox);
    if ($accShort){ $accShort.textContent = short(userAddr); $accShort.href = `${EXPLORER}/address/${userAddr}`; }
    await refreshBalances();
    await refreshRegisteredMenu();
    await refreshPriceChip();
  }

  function disconnect(){
    provider = undefined; signer = undefined; userAddr = undefined;
    hide($walletBox); show($btnConnect); hide($menuBox);
  }

  async function refreshRegisteredMenu(){
    if (!muaban || !userAddr){ hide($menuBox); return; }
    try{
      const isReg = await muaban.registered(userAddr);
      show($menuBox);
      if (isReg){ hide($btnRegister); show($btnCreate); show($btnOrdersBuy); show($btnOrdersSell); }
      else{ show($btnRegister); hide($btnCreate); hide($btnOrdersBuy); hide($btnOrdersSell); }
    }catch(e){ console.warn('registered() error', e); hide($menuBox); }
  }

  // --------------------------- Approvals helpers ---------------------------
  async function ensureAllowance(requiredWei){
    const allow = await vin.allowance(userAddr, MUABAN_ADDR);
    if (allow.gte(requiredWei)) return true;
    const tx = await vin.connect(signer).approve(MUABAN_ADDR, requiredWei);
    toast('Đang phê duyệt VIN…'); await tx.wait(); return true;
  }

  // --------------------------- Registration ---------------------------
  async function onRegister(){
    if (!signer) return toast('Hãy kết nối ví trước.', 'warn');
    try{
      const regFee = await muaban.REG_FEE().catch(()=>REG_FEE_WEI_FALLBACK);
      await ensureAllowance(regFee);
      const tx = await muaban.connect(signer).payRegistration();
      toast('Đang đăng ký ví…'); await tx.wait();
      toast('Đăng ký thành công!'); await refreshRegisteredMenu(); await refreshBalances();
    }catch(e){ console.error(e); toast('Đăng ký thất bại. Kiểm tra VIN & phí gas VIC.', 'error'); }
  }

  // --------------------------- Create Product ---------------------------
  function openCreateModal(){ if (!signer) return toast('Hãy kết nối ví trước.', 'warn'); lockScroll(); show($formCreate); }
  function closeModals(){ $$('.modal').forEach(hide); unlockScroll(); }

  async function onSubmitCreate(){
    try{
      let name = ($createName.value||'').trim();
      const ipfs = ($createIPFS.value||'').trim();
      const unit = ($createUnit.value||'').trim();
      const priceStr = String(($createPrice.value||'')).trim();
      const payout = ($createWallet.value||'').trim();
      const days = parseInt(($createDays.value||'').trim() || '0', 10);

      if (!/^\d+$/.test(priceStr)) return toast('Giá (VND) phải là số nguyên dương.', 'warn');
      const priceVND = ethers.BigNumber.from(priceStr);

      if (!name) return toast('Vui lòng nhập Tên.', 'warn');
      if (unit)  name = `${name} · ${unit}`;
      if (name.length > 120) return toast('Tên quá dài (>120 ký tự).', 'warn');
      if (!ipfs || ipfs.length < 6) return toast('IPFS/URL chưa hợp lệ.', 'warn');
      if (!priceVND.gt(0)) return toast('Giá (VND) phải > 0.', 'warn');
      if (!(days>0))       return toast('Số ngày giao hàng phải > 0.', 'warn');
      if (!ethers.utils.isAddress(payout)) return toast('Ví nhận thanh toán không hợp lệ.', 'warn');

      const isReg = await muaban.registered(userAddr);
      if (!isReg) return toast('Ví chưa đăng ký (0.001 VIN). Hãy bấm "Đăng ký ví" trước.', 'warn');

      // Preflight (no gas): capture exact revert reasons
      try{
        await muaban.connect(signer).callStatic.createProduct(
          name, ipfs, ipfs, priceVND.toString(), days, payout, true
        );
      }catch(preErr){ const why = decodeRevertReason(preErr); return toast('Không thể đăng (preflight): ' + (why||'REVERT'), 'error'); }

      let gas = ethers.BigNumber.from('250000');
      try{
        gas = await muaban.connect(signer).estimateGas.createProduct(
          name, ipfs, ipfs, priceVND.toString(), days, payout, true
        );
      }catch(estErr){ console.warn('[estimateGas failed]', estErr); }

      const tx = await muaban.connect(signer).createProduct(
        name, ipfs, ipfs, priceVND.toString(), days, payout, true,
        { gasLimit: gas.mul(120).div(100) }
      );
      toast('Đang đăng sản phẩm…'); await tx.wait();
      toast('Đăng sản phẩm thành công.'); closeModals(); await scanAndRenderProducts();
    }catch(e){
      const reason = decodeRevertReason(e);
      toast('Không thể đăng sản phẩm: ' + (reason||'Ví/RPC lỗi chung'), 'error');
      console.error('[createProduct failed]', e);
    }
  }

  // --------------------------- Update Product ---------------------------
  function openUpdateModal(prod){
    if (!signer) return toast('Hãy kết nối ví trước.', 'warn');
    $updatePid.value = String(prod.productId);
    $updatePrice.value = String(prod.priceVND);
    $updateDays.value = String(prod.deliveryDaysMax);
    $updateWallet.value = String(prod.payoutWallet);
    $updateActive.checked = !!prod.active;
    lockScroll(); show($formUpdate);
  }

  async function onSubmitUpdate(){
    try{
      const pid = parseInt($updatePid.value);
      const priceStr = String(($updatePrice.value||'')).trim();
      if (!/^\d+$/.test(priceStr)) return toast('Giá (VND) phải là số nguyên dương.', 'warn');
      const priceVND = ethers.BigNumber.from(priceStr);
      const days = parseInt($updateDays.value||'0',10);
      const payout = ($updateWallet.value||'').trim();
      const active = !!$updateActive.checked;

      if (!(pid>0) || !priceVND.gt(0) || !(days>0) || !ethers.utils.isAddress(payout)) {
        return toast('Thông tin cập nhật chưa hợp lệ.', 'warn');
      }

      // Preflight
      try{
        await muaban.connect(signer).callStatic.updateProduct(pid, priceVND.toString(), days, payout, active);
      }catch(preErr){ return toast('Cập nhật lỗi (preflight): ' + (decodeRevertReason(preErr)||'REVERT'), 'error'); }

      let gas = ethers.BigNumber.from('200000');
      try{ gas = await muaban.connect(signer).estimateGas.updateProduct(pid, priceVND.toString(), days, payout, active); }catch(_){}
      const tx = await muaban.connect(signer).updateProduct(pid, priceVND.toString(), days, payout, active, { gasLimit: gas.mul(120).div(100) });
      toast('Đang cập nhật sản phẩm…'); await tx.wait();
      toast('Cập nhật thành công.'); closeModals(); await scanAndRenderProducts();
    }catch(e){ toast('Cập nhật thất bại: ' + (decodeRevertReason(e)||'RPC lỗi'), 'error'); }
  }

  // --------------------------- Buy flow ---------------------------
  let currentBuyProd = null;

  function openBuyModal(prod){
    if (!signer) return toast('Hãy kết nối ví trước.', 'warn');
    if (!vndPerVIN || !vinPerVNDWeiBI){ toast('Đang tải giá… thử lại sau.', 'warn'); return; }
    currentBuyProd = prod;
    $buyQty.value = '1';
    $buyName.value = ''; $buyAddress.value = ''; $buyPhone.value = ''; $buyNote.value = '';
    $buyInfo.innerHTML = `
      <div class="product-brief">
        <div><strong>${escapeHtml(prod.name)}</strong></div>
        <div class="product-row">Giá: <span class="order-strong">${fmtVND(prod.priceVND)} VND</span></div>
        <div class="product-row">Giao tối đa: ${prod.deliveryDaysMax} ngày</div>
      </div>`;
    updateBuyTotal(); lockScroll(); show($formBuy);
  }

  function updateBuyTotal(){
    try{
      const qty = BigInt(Math.max(1, parseInt($buyQty.value||'1')));
      const priceVND = BigInt(currentBuyProd.priceVND);
      const totalVND = priceVND * qty;
      const totalWei = ceilDivBI(totalVND * vinPerVNDWeiBI, 1n);
      $buyTotalVIN.textContent = 'Tổng VIN cần trả: ' + fmtVIN(ethers.BigNumber.from(totalWei.toString()));
    }catch(_){ $buyTotalVIN.textContent = 'Tổng VIN cần trả: …'; }
  }

  async function onSubmitBuy(){
    if (!currentBuyProd) return;
    try{
      const isReg = await muaban.registered(userAddr);
      if (!isReg) return toast('Ví chưa đăng ký (0.001 VIN). Vui lòng đăng ký trước.', 'warn');

      const qty = BigInt(Math.max(1, parseInt($buyQty.value||'1')));
      const priceVND = BigInt(currentBuyProd.priceVND);
      const totalVND = priceVND * qty;
      const needWeiBI = ceilDivBI(totalVND * vinPerVNDWeiBI, 1n);

      await ensureAllowance(ethers.BigNumber.from(needWeiBI.toString()));

      const infoObj = {
        name: ($buyName.value||'').trim(),
        address: ($buyAddress.value||'').trim(),
        phone: ($buyPhone.value||'').trim(),
        note: ($buyNote.value||'').trim()
      };
      if (!infoObj.name || !infoObj.address || !infoObj.phone){
        return toast('Hãy nhập đủ Họ tên, Địa chỉ, và SĐT.', 'warn');
      }
      const cipher = encodeBuyerInfo(infoObj);

      // Preflight
      try{
        await muaban.connect(signer).callStatic.placeOrder(
          currentBuyProd.productId,
          ethers.BigNumber.from(qty.toString()),
          ethers.BigNumber.from(vinPerVNDWeiBI.toString()),
          cipher
        );
      }catch(preErr){ return toast('Đặt hàng lỗi (preflight): ' + (decodeRevertReason(preErr)||'REVERT'), 'error'); }

      let gas = ethers.BigNumber.from('250000');
      try{
        gas = await muaban.connect(signer).estimateGas.placeOrder(
          currentBuyProd.productId,
          ethers.BigNumber.from(qty.toString()),
          ethers.BigNumber.from(vinPerVNDWeiBI.toString()),
          cipher
        );
      }catch(_){}
      const tx = await muaban.connect(signer).placeOrder(
        currentBuyProd.productId,
        ethers.BigNumber.from(qty.toString()),
        ethers.BigNumber.from(vinPerVNDWeiBI.toString()),
        cipher,
        { gasLimit: gas.mul(120).div(100) }
      );
      toast('Đang đặt hàng…'); await tx.wait();
      toast('Đặt hàng thành công!'); closeModals(); await refreshBalances();
    }catch(e){ toast('Mua hàng thất bại: ' + (decodeRevertReason(e)||'RPC lỗi'), 'error'); }
  }

  // --------------------------- Products list ---------------------------
  async function scanAndRenderProducts(){
    productsCache = [];
    for (let pid=1; pid<=MAX_PRODUCT_SCAN; pid++){
      try{
        const p = await muaban.getProduct(pid);
        if (!p || !p.seller || p.seller === ethers.constants.AddressZero) continue;
        productsCache.push(p);
      }catch(_){ /* continue */ }
    }
    renderProducts(productsCache);
  }

  function renderProducts(list){
    $productList.innerHTML = '';
    if (!list || list.length===0){
      $productList.innerHTML = `<div class="tag">Chưa có sản phẩm.</div>`;
      return;
    }
    for (const p of list){
      const mine = (userAddr && p.seller.toLowerCase() === userAddr.toLowerCase());
      const active = !!p.active;
      const img = toImageUrl(p.imageCID || p.descriptionCID);
      const unit = extractUnitFromName(p.name);

      const card = document.createElement('div');
      card.className = 'product-card';
      card.innerHTML = `
        <img class="product-thumb" src="${escapeAttr(img)}" alt="thumb" onerror="this.src='https://ipfs.io/ipfs/bafybeidzgspoyuzw4y4r2kq7v3d7cuiq3o5n4n4d6m2cno4z7l2m6q2jcm';" />
        <div class="product-info">
          <div class="product-top">
            <h3 class="product-title">${escapeHtml(p.name)}</h3>
            <span class="stock-badge ${active?'':'out'}">${active?'Còn hàng':'Hết hàng'}</span>
          </div>
          <div class="product-meta">
            <span class="price-vnd">${fmtVND(p.priceVND)} VND</span>
            ${unit? `<span class="unit">/ ${escapeHtml(unit)}</span>`:''}
          </div>
          <div class="card-actions">
            ${active ? `<button class="btn buy-btn">Mua</button>` : ''}
            ${mine ? `<button class="btn">Cập nhật</button>` : ''}
            <a class="btn" target="_blank" rel="noopener" href="${EXPLORER}/address/${p.seller}">Xem người bán</a>
          </div>
        </div>`;

      const [buyBtn, updBtn] = card.querySelectorAll('.btn');
      if (active && buyBtn){
        buyBtn.addEventListener('click', ()=> openBuyModal({
          productId: p.productId.toNumber ? p.productId.toNumber() : Number(p.productId),
          name: p.name,
          priceVND: p.priceVND.toString ? p.priceVND.toString() : String(p.priceVND),
          deliveryDaysMax: p.deliveryDaysMax.toNumber ? p.deliveryDaysMax.toNumber() : Number(p.deliveryDaysMax),
          payoutWallet: p.payoutWallet,
          active: p.active
        }));
      }
      if (mine && updBtn){
        updBtn.addEventListener('click', ()=> openUpdateModal({
          productId: p.productId.toNumber ? p.productId.toNumber() : Number(p.productId),
          name: p.name,
          priceVND: p.priceVND.toString ? p.priceVND.toString() : String(p.priceVND),
          deliveryDaysMax: p.deliveryDaysMax.toNumber ? p.deliveryDaysMax.toNumber() : Number(p.deliveryDaysMax),
          payoutWallet: p.payoutWallet,
          active: p.active
        }));
      }
      $productList.appendChild(card);
    }
  }

  function extractUnitFromName(name){
    const parts = String(name||'').split('·').map(s=>s.trim());
    if (parts.length>=2) return parts[parts.length-1];
    return '';
  }

  // --------------------------- Search ---------------------------
  function doSearch(){
    const q = ($searchInput.value||'').trim().toLowerCase();
    if (!q) return renderProducts(productsCache);
    const filtered = productsCache.filter(p => String(p.name||'').toLowerCase().includes(q));
    renderProducts(filtered);
  }

  // --------------------------- Wire UI events ---------------------------
  function wire(){
    $btnConnect?.addEventListener('click', connect);
    $btnDisconnect?.addEventListener('click', disconnect);
    $btnRegister?.addEventListener('click', onRegister);

    $btnCreate?.addEventListener('click', openCreateModal);
    $btnSubmitCreate?.addEventListener('click', onSubmitCreate);
    $formCreate?.querySelector('.close')?.addEventListener('click', closeModals);

    $btnSubmitUpdate?.addEventListener('click', onSubmitUpdate);
    $formUpdate?.querySelector('.close')?.addEventListener('click', closeModals);

    $btnSubmitBuy?.addEventListener('click', onSubmitBuy);
    $formBuy?.querySelector('.close')?.addEventListener('click', closeModals);
    $buyQty?.addEventListener('input', updateBuyTotal);

    $btnSearch?.addEventListener('click', doSearch);
    $searchInput?.addEventListener('keydown', (e)=> { if (e.key==='Enter') doSearch(); });

    if (window.ethereum?.on){
      window.ethereum.on('accountsChanged', ()=> window.location.reload());
      window.ethereum.on('chainChanged',   ()=> window.location.reload());
    }
  }

  // --------------------------- Init ---------------------------
  async function boot(){
    wire();
    provider = new ethers.providers.JsonRpcProvider(VIC_RPC, { chainId: VIC_CHAIN_ID_DEC, name:'viction' });
    await initContracts();
    refreshPriceChip(); setInterval(refreshPriceChip, 60_000);
    await scanAndRenderProducts();
  }

  boot();

})();