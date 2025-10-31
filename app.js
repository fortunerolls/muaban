/* =============================================================
   muaban.vin — app.js (Full)
   - Ethers v5 (UMD) already loaded in index.html
   - Chain: Viction Mainnet (chainId 88)
   - Contract: MuabanVND (escrow commerce, VND pricing, VIN payment)
   - Token: VIN (ERC20-like with 18 decimals)
   - Pricing: 1 VIN (VND) = (VIC/USDT from Binance × 100) × (USDT/VND from CoinGecko)
   - UI: see index.html IDs/classes
   ============================================================= */

(function(){
  'use strict';

  // --------------------------- Constants ---------------------------
  const VIC_CHAIN_ID_DEC = 88;
  const VIC_CHAIN_ID_HEX = '0x58';
  const VIC_RPC = 'https://rpc.viction.xyz';
  const EXPLORER = 'https://www.vicscan.xyz';

  const MUABAN_ADDR = '0x190FD18820498872354eED9C4C080cB365Cd12E0'; // MuabanVND
  const VIN_ADDR    = '0x941F63807401efCE8afe3C9d88d368bAA287Fac4'; // VIN Token

  // REG_FEE (0.001 VIN) is read on-chain, but keep as fallback:
  const REG_FEE_WEI_FALLBACK = ethers.BigNumber.from('1000000000000000'); // 1e15

  // How many products to scan (since contract does not expose product count)
  const MAX_PRODUCT_SCAN = 200;

  // Pricing sources
  const BINANCE_VICUSDT = 'https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT';
  const COINGECKO_USDTVND = 'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd';

  // --------------------------- ABIs (minimal) ---------------------------
  // From Muaban_ABI.json (trimmed to the functions we call)
  const MUABAN_ABI = [
    { "inputs": [{"internalType": "address","name": "vinToken","type": "address"}], "stateMutability": "nonpayable","type":"constructor" },
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

  // From VinToken_ABI.json (trimmed)
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

  // Cached pricing
  let vndPerVIN = null;          // number (for UI)
  let vinPerVNDWeiBI = null;     // BigInt (wei per 1 VND)

  // Local cache of products (scanned)
  let productsCache = [];        // array of product objects

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
    // keep up to 6 decimals for readability
    const [a,b=''] = s.split('.');
    return a + (b? '.'+b.slice(0,6).replace(/0+$/,'') : '');
  }

  // Convert possible ipfs://CID or https links to https gateway
  function toImageUrl(cidOrUrl){
    if (!cidOrUrl) return '';
    if (cidOrUrl.startsWith('ipfs://')){
      return 'https://ipfs.io/ipfs/' + cidOrUrl.replace('ipfs://','');
    }
    if (/^https?:\/\//i.test(cidOrUrl)) return cidOrUrl;
    // assume raw CID
    return 'https://ipfs.io/ipfs/' + cidOrUrl;
  }

  // Encode buyer info -> base64(JSON)
  function encodeBuyerInfo(obj){
    const json = JSON.stringify(obj);
    // Handle unicode safely
    const b64 = btoa(unescape(encodeURIComponent(json)));
    return b64;
  }

  // BigInt helpers
  const ONE_E18 = 1000000000000000000n;
  const ONE_E6  = 1000000n;

  function toScaledInt(strOrNum, scale=ONE_E6){
    // Convert decimal string/number to integer with given scale (BigInt).
    const s = String(strOrNum);
    if (!s.includes('.')) return BigInt(Math.round(Number(s))) * scale;
    const [a,b] = s.split('.');
    const bPad = (b+'000000').slice(0,6); // 6 decimals
    const ai = BigInt(a||'0');
    const bi = BigInt(bPad);
    return ai*scale + bi;
  }

  function ceilDivBI(a, b){
    // a,b BigInt; ceil(a / b)
    return (a + b - 1n) / b;
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
        // add then switch
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

  // --------------------------- Pricing ---------------------------
  async function refreshPriceChip(){
    try{
      const [vicRes, cgRes] = await Promise.all([
        fetch(BINANCE_VICUSDT, { cache: 'no-store' }),
        fetch(COINGECKO_USDTVND, { cache: 'no-store' })
      ]);
      const vicJson = await vicRes.json();
      const cgJson  = await cgRes.json();

      const vicUsdtStr = vicJson?.price || vicJson?.lastPrice || vicJson?.weightedAvgPrice;
      const usdtVndVal = cgJson?.tether?.vnd;

      if (!vicUsdtStr || !usdtVndVal) throw new Error('Price feed missing');

      // vndPerVIN = vic_usdt * 100 * usdt_vnd
      const vic_usdt_scaled = toScaledInt(vicUsdtStr, ONE_E6); // 6d
      const usdt_vnd_scaled = toScaledInt(usdtVndVal, ONE_E6); // treat as decimal too
      const vndPerVIN_scaled = (vic_usdt_scaled * 100n * usdt_vnd_scaled) / ONE_E6; // scale: 1e6 * 1e6 / 1e6 = 1e6

      // wei per 1 VND = 1e18 * 1e6 / vndPerVIN_scaled
      const numerator = ONE_E18 * ONE_E6; // 1e24
      const vinPerVNDWei = numerator / (vndPerVIN_scaled === 0n ? 1n : vndPerVIN_scaled);

      vinPerVNDWeiBI = vinPerVNDWei;
      // For UI, convert vndPerVIN_scaled (1e6) -> number
      const vndPerVIN_num = Number(vndPerVIN_scaled) / 1e6;
      vndPerVIN = vndPerVIN_num;

      if ($vinPriceChip){
        $vinPriceChip.textContent = `1 VIN = ${fmtVND(Math.floor(vndPerVIN_num))} VND`;
      }
    }catch(e){
      console.warn('Price error', e);
      if ($vinPriceChip) $vinPriceChip.textContent = '1 VIN = … VND';
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
    }catch(e){
      toast('Không đọc được số dư.', 'warn');
    }
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
    // UI
    hide($btnConnect);
    show($walletBox);
    if ($accShort){
      $accShort.textContent = short(userAddr);
      $accShort.href = `${EXPLORER}/address/${userAddr}`;
    }
    await refreshBalances();
    await refreshRegisteredMenu();
    await refreshPriceChip();
  }

  function disconnect(){
    // MetaMask doesn't support programmatic disconnection; just reset UI state
    provider = undefined; signer = undefined; userAddr = undefined;
    hide($walletBox);
    show($btnConnect);
    hide($menuBox);
  }

  async function refreshRegisteredMenu(){
    if (!muaban || !userAddr){
      hide($menuBox);
      return;
    }
    try{
      const isReg = await muaban.registered(userAddr);
      show($menuBox);
      if (isReg){
        hide($btnRegister);
        show($btnCreate);
        show($btnOrdersBuy);
        show($btnOrdersSell);
      }else{
        show($btnRegister);
        hide($btnCreate);
        hide($btnOrdersBuy);
        hide($btnOrdersSell);
      }
    }catch(e){
      console.warn('registered() error', e);
      hide($menuBox);
    }
  }

  // --------------------------- Approvals helpers ---------------------------
  async function ensureAllowance(requiredWei){
    const owner = userAddr;
    const spender = MUABAN_ADDR;
    const allow = await vin.allowance(owner, spender);
    if (allow.gte(requiredWei)) return true;

    const tx = await vin.connect(signer).approve(spender, requiredWei);
    toast('Đang phê duyệt VIN…');
    await tx.wait();
    return true;
  }

  // --------------------------- Registration ---------------------------
  async function onRegister(){
    if (!signer) return toast('Hãy kết nối ví trước.', 'warn');
    try{
      const regFee = await muaban.REG_FEE().catch(()=>REG_FEE_WEI_FALLBACK);
      await ensureAllowance(regFee);
      const tx = await muaban.connect(signer).payRegistration();
      toast('Đang đăng ký ví…');
      await tx.wait();
      toast('Đăng ký thành công!');
      await refreshRegisteredMenu();
      await refreshBalances();
    }catch(e){
      console.error(e);
      toast('Đăng ký thất bại. Kiểm tra số dư VIN & VIC (phí gas).', 'error');
    }
  }

  // --------------------------- Create Product ---------------------------
  function openCreateModal(){
    if (!signer) return toast('Hãy kết nối ví trước.', 'warn');
    lockScroll();
    show($formCreate);
  }
  function closeModals(){
    $$('.modal').forEach(hide);
    unlockScroll();
  }

  async function onSubmitCreate(){
    try{
      const name = ($createName.value||'').trim();
      const ipfs = ($createIPFS.value||'').trim();
      const unit = ($createUnit.value||'').trim();
      const priceVND = ethers.BigNumber.from(($createPrice.value||'0').toString());
      const payout = ($createWallet.value||'').trim();
      const days = parseInt($createDays.value||'0');

      if (!name || !ipfs || !priceVND.gt(0) || !payout || days<=0){
        return toast('Vui lòng nhập đủ: Tên, IPFS, Giá, Ví nhận, Ngày giao.', 'warn');
      }
      // Persist unit by appending to name (since contract model lacks "unit")
      const finalName = unit ? `${name} · ${unit}` : name;

      const tx = await muaban.connect(signer).createProduct(
        finalName,
        ipfs,                 // descriptionCID (tạm lưu ipfs)
        ipfs,                 // imageCID (cùng link)
        priceVND.toString(),
        days,
        payout,
        true                  // active default
      );
      toast('Đang đăng sản phẩm…');
      const rc = await tx.wait();
      toast('Đăng sản phẩm thành công.');
      closeModals();
      await scanAndRenderProducts(); // refresh list
    }catch(e){
      console.error(e);
      toast('Không thể đăng sản phẩm: Ví/RPC trả lỗi chung. Kiểm tra kết nối ví, mạng VIC, phí gas VIC và thử lại.', 'error');
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
    lockScroll();
    show($formUpdate);
  }

  async function onSubmitUpdate(){
    try{
      const pid = parseInt($updatePid.value);
      const priceVND = ethers.BigNumber.from(($updatePrice.value||'0').toString());
      const days = parseInt($updateDays.value||'0');
      const payout = ($updateWallet.value||'').trim();
      const active = !!$updateActive.checked;

      if (!(pid>0) || !priceVND.gt(0) || !(days>0) || !payout) {
        return toast('Thông tin cập nhật chưa hợp lệ.', 'warn');
      }
      const tx = await muaban.connect(signer).updateProduct(
        pid, priceVND.toString(), days, payout, active
      );
      toast('Đang cập nhật sản phẩm…');
      await tx.wait();
      toast('Cập nhật thành công.');
      closeModals();
      await scanAndRenderProducts();
    }catch(e){
      console.error(e);
      toast('Cập nhật thất bại. Kiểm tra quyền sở hữu & phí gas.', 'error');
    }
  }

  // --------------------------- Buy flow ---------------------------
  let currentBuyProd = null;

  function openBuyModal(prod){
    if (!signer) return toast('Hãy kết nối ví trước.', 'warn');
    if (!vndPerVIN || !vinPerVNDWeiBI){
      toast('Đang tải giá… Vui lòng thử lại sau vài giây.', 'warn');
      return;
    }
    currentBuyProd = prod;
    $buyQty.value = '1';
    $buyName.value = '';
    $buyAddress.value = '';
    $buyPhone.value = '';
    $buyNote.value = '';
    $buyInfo.innerHTML = `
      <div class="product-brief">
        <div><strong>${escapeHtml(prod.name)}</strong></div>
        <div class="product-row">Giá: <span class="order-strong">${fmtVND(prod.priceVND)} VND</span></div>
        <div class="product-row">Giao tối đa: ${prod.deliveryDaysMax} ngày</div>
      </div>
    `;
    updateBuyTotal();
    lockScroll();
    show($formBuy);
  }

  function updateBuyTotal(){
    try{
      const qty = BigInt(Math.max(1, parseInt($buyQty.value||'1')));
      const priceVND = BigInt(currentBuyProd.priceVND);
      const totalVND = priceVND * qty;
      const totalWei = ceilDivBI(totalVND * vinPerVNDWeiBI, 1n);
      $buyTotalVIN.textContent = 'Tổng VIN cần trả: ' + fmtVIN(ethers.BigNumber.from(totalWei.toString()));
    }catch(e){
      $buyTotalVIN.textContent = 'Tổng VIN cần trả: …';
    }
  }

  async function onSubmitBuy(){
    if (!currentBuyProd) return;
    try{
      // ensure registered first
      const isReg = await muaban.registered(userAddr);
      if (!isReg){
        return toast('Ví của bạn chưa đăng ký (0.001 VIN). Vui lòng đăng ký trước.', 'warn');
      }
      const qty = BigInt(Math.max(1, parseInt($buyQty.value||'1')));
      const priceVND = BigInt(currentBuyProd.priceVND);
      const totalVND = priceVND * qty;
      const needWeiBI = ceilDivBI(totalVND * vinPerVNDWeiBI, 1n); // ceil

      // Ensure allowance
      await ensureAllowance(ethers.BigNumber.from(needWeiBI.toString()));

      // Encode buyer info
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

      const tx = await muaban.connect(signer).placeOrder(
        currentBuyProd.productId,
        ethers.BigNumber.from(qty.toString()),
        ethers.BigNumber.from(vinPerVNDWeiBI.toString()),
        cipher
      );
      toast('Đang đặt hàng…');
      await tx.wait();
      toast('Đặt hàng thành công!');
      closeModals();
      await refreshBalances();
    }catch(e){
      console.error(e);
      toast('Mua hàng thất bại. Kiểm tra số dư VIN & VIC và thử lại.', 'error');
    }
  }

  // --------------------------- Products list ---------------------------
  async function scanAndRenderProducts(){
    productsCache = [];
    const cards = [];
    for (let pid=1; pid<=MAX_PRODUCT_SCAN; pid++){
      try{
        const p = await muaban.getProduct(pid);
        if (!p || !p.seller || p.seller === ethers.constants.AddressZero) continue;
        productsCache.push(p);
      }catch(e){
        // break only if continuous errors? We'll just continue.
      }
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
      const unit = extractUnitFromName(p.name); // "Tên · đơn vị" -> lấy phần sau
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
        </div>
      `;
      // Wire actions
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

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
  function escapeAttr(s){ return escapeHtml(s).replace(/"/g, '&quot;'); }

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

    // chain/account changes
    if (window.ethereum?.on){
      window.ethereum.on('accountsChanged', ()=> window.location.reload());
      window.ethereum.on('chainChanged',   ()=> window.location.reload());
    }
  }

  // --------------------------- Init (public) ---------------------------
  async function boot(){
    wire();
    // Init read-only provider for public data
    provider = new ethers.providers.JsonRpcProvider(VIC_RPC, { chainId: VIC_CHAIN_ID_DEC, name:'viction' });
    await initContracts();
    // Public data
    refreshPriceChip();
    setInterval(refreshPriceChip, 30_000);
    await scanAndRenderProducts();
  }

  // Start
  boot();

})();
