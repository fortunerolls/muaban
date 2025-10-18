// ========================== Muaban.vin — app.js ==========================
// Ethers v5.7.2 is loaded via CDN in index.html

(function(){
  'use strict';

  // --------------------------- Constants ---------------------------
  const VIC_CHAIN_ID_DEC = 88;
  const VIC_CHAIN_ID_HEX = '0x58';

  // Contract addresses (VIC mainnet)
  const MUABAN_ADDR = '0x190FD18820498872354eED9C4C080cB365Cd12E0'; // MuabanVND
  const VIN_ADDR    = '0x941F63807401efCE8afe3C9d88d368bAA287Fac4';   // VIN (ERC20)
  // API endpoints for price -> VIN/VND = (VIC/USDT * 100) * (USDT/VND)
  const BINANCE_VICUSDT = 'https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT';
  const COINGECKO_USDTVND = 'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd';

  // Scan limits (no global index in contract, we probe a safe window)
  const MAX_PRODUCT_SCAN = 200;
  const MAX_ORDER_SCAN   = 200;

  // Minimal ABIs (only methods we use) from your ABI files
  // Muaban_ABI.json (trimmed)  :contentReference[oaicite:5]{index=5}
  const MUABAN_ABI = [
    {"inputs":[{"internalType":"address","name":"vinToken","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},
    {"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"REG_FEE","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"vin","outputs":[{"internalType":"contract IERC20","name":"","type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"vinDecimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},

    {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"registered","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"name":"getProduct","outputs":[{"components":[
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
    ],"internalType":"struct MuabanVND.Product","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"address","name":"seller","type":"address"}],"name":"getSellerProductIds","outputs":[{"internalType":"uint256[]","name":"","type":"uint256[]"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"name":"getOrder","outputs":[{"components":[
      {"internalType":"uint256","name":"orderId","type":"uint256"},
      {"internalType":"uint256","name":"productId","type":"uint256"},
      {"internalType":"address","name":"buyer","type":"address"},
      {"internalType":"address","name":"seller","type":"address"},
      {"internalType":"uint256","name":"quantity","type":"uint256"},
      {"internalType":"uint256","name":"vinAmount","type":"uint256"},
      {"internalType":"uint256","name":"placedAt","type":"uint256"},
      {"internalType":"uint256","name":"deadline","type":"uint256"},
      {"internalType":"uint8","name":"status","type":"uint8"},
      {"internalType":"string","name":"buyerInfoCipher","type":"string"}
    ],"internalType":"struct MuabanVND.Order","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},

    {"inputs":[],"name":"payRegistration","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"descriptionCID","type":"string"},{"internalType":"string","name":"imageCID","type":"string"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"}],"name":"createProduct","outputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"},{"internalType":"uint256","name":"priceVND","type":"uint256"},{"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},{"internalType":"address","name":"payoutWallet","type":"address"},{"internalType":"bool","name":"active","type":"bool"}],"name":"updateProduct","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"},{"internalType":"bool","name":"active","type":"bool"}],"name":"setProductActive","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"productId","type":"uint256"},{"internalType":"uint256","name":"quantity","type":"uint256"},{"internalType":"uint256","name":"vinPerVND","type":"uint256"},{"internalType":"string","name":"buyerInfoCipher","type":"string"}],"name":"placeOrder","outputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],"name":"confirmReceipt","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],"name":"refundIfExpired","outputs":[],"stateMutability":"nonpayable","type":"function"}
  ];

  // ERC20 minimal ABI from your VIN token ABI (trim)  :contentReference[oaicite:6]{index=6}
  const ERC20_ABI = [
    {"constant":true,"inputs":[{"name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"type":"function"},
    {"constant":true,"inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}],"name":"allowance","outputs":[{"name":"","type":"uint256"}],"type":"function"},
    {"constant":false,"inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"name":"approve","outputs":[{"name":"","type":"bool"}],"type":"function"},
    {"constant":true,"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"type":"function"}
  ];

  // --------------------------- State ---------------------------
  let provider = null;
  let signer   = null;
  let userAddr = null;

  let muaban   = null;
  let vinToken = null;

  // dynamic price cache
  let vinVND = null;     // number (price of 1 VIN in VND)
  let vinPerVND = null;  // BigNumber (wei per 1 VND)

  // --------------------------- Helpers ---------------------------
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const short = a => a ? (a.slice(0,6)+'…'+a.slice(-4)) : '';

  function fmtVND(n){
    // integer VND -> "1.234.567 VND"
    try{
      return Number(n).toLocaleString('vi-VN', {maximumFractionDigits:0});
    }catch{ return String(n); }
  }

  function openModal(sectionId){
    document.body.classList.add('no-scroll');
    $(sectionId).classList.remove('hidden');
  }
  function closeModals(){
    document.body.classList.remove('no-scroll');
    $$('.modal').forEach(m=>m.classList.add('hidden'));
  }

  function ipfsThumb(cidOrUrl){
    if(!cidOrUrl) return '';
    if(/^ipfs:\/\//i.test(cidOrUrl)){
      return 'https://ipfs.io/ipfs/'+cidOrUrl.replace(/^ipfs:\/\//i,'');
    }
    if(/^https?:\/\//i.test(cidOrUrl)) return cidOrUrl;
    // assume raw CID
    return 'https://ipfs.io/ipfs/'+cidOrUrl;
  }

  // Encode buyer info (simple base64 JSON, per spec: "UI mã hóa")  :contentReference[oaicite:7]{index=7}
  function encodeBuyerInfo({name,address,phone,note}){
    const payload = JSON.stringify({name,address,phone,note,ts:Date.now()});
    return btoa(unescape(encodeURIComponent(payload)));
  }

  function toast(msg, type='info'){
    // Simple UX without external lib:
    console.log(`[${type}]`, msg);
    alert(msg);
  }

  // --------------------------- Wallet / Network ---------------------------
  async function ensureViction(){
    if(!window.ethereum) return false;
    const chainId = await window.ethereum.request({ method: 'eth_chainId' });
    if(chainId === VIC_CHAIN_ID_HEX) return true;
    try{
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: VIC_CHAIN_ID_HEX }]
      });
      return true;
    }catch(err){
      if(err && err.code === 4902){
        // add then switch
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: VIC_CHAIN_ID_HEX,
            chainName: 'Viction Mainnet',
            nativeCurrency: { name:'VIC', symbol:'VIC', decimals:18 },
            rpcUrls: ['https://rpc.viction.xyz'],
            blockExplorerUrls: ['https://www.vicscan.xyz']
          }]
        });
        return true;
      }
      return false;
    }
  }

  async function connect(){
    if(!window.ethereum){ toast('Không tìm thấy ví (MetaMask).', 'warn'); return; }
    provider = new ethers.providers.Web3Provider(window.ethereum, 'any');
    await provider.send('eth_requestAccounts', []);
    if(!(await ensureViction())){ toast('Please switch to Viction (Chain 88).', 'warn'); return; }
    signer = provider.getSigner();
    userAddr = await signer.getAddress();

    // contracts
    muaban   = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
    vinToken = new ethers.Contract(VIN_ADDR, ERC20_ABI, signer);

    // UI
    $('#btnConnect').classList.add('hidden');
    $('#walletBox').classList.remove('hidden');
    $('#accountShort').textContent = short(userAddr);
    $('#accountShort').href = `https://www.vicscan.xyz/address/${userAddr}`;

    // reactive listeners
    window.ethereum?.on?.('accountsChanged', ()=>location.reload());
    window.ethereum?.on?.('chainChanged', ()=>location.reload());

    await refreshBalances();
    await setupMenuByRegistration();
  }

  async function disconnect(){
    // MetaMask doesn't support programmatic disconnect; just reset UI
    location.reload();
  }

  async function refreshBalances(){
    if(!provider || !signer) return;
    const [vicWei, vinBal] = await Promise.all([
      provider.getBalance(userAddr),
      vinToken.balanceOf(userAddr)
    ]);
    $('#vicBalance').textContent = `VIC: ${ethers.utils.formatEther(vicWei)}`;
    $('#vinBalance').textContent = `VIN: ${ethers.utils.formatEther(vinBal)}`;
  }

  // --------------------------- Price / Rate ---------------------------
  // Follow spec: VIN/VND = (VICUSDT * 100) * (USDT/VND)  :contentReference[oaicite:8]{index=8}
  async function fetchVinPrice(){
    try{
      const [bRes, cRes] = await Promise.all([
        fetch(BINANCE_VICUSDT, {cache:'no-store'}),
        fetch(COINGECKO_USDTVND, {cache:'no-store'})
      ]);
      const b = await bRes.json(); // {symbol:'VICUSDT', price:'x.xxxxx'}
      const c = await cRes.json(); // { tether: { vnd: N } }

      const vicUsdt = Number(b?.price || 0);            // price of 1 VIC in USDT
      const usdtVnd = Number(c?.tether?.vnd || 0);      // price of 1 USDT in VND
      if(!vicUsdt || !usdtVnd) throw new Error('No price');

      const priceVinVnd = vicUsdt * 100 * usdtVnd;      // price of 1 VIN in VND
      vinVND = Math.floor(priceVinVnd);                 // làm tròn xuống (theo mô tả)
      $('#vinPrice').textContent = `1 VIN = ${fmtVND(vinVND)} VND`;

      // Compute vinPerVND (wei per 1 VND), round UP so seller is protected
      // vinPerVND = 1e18 / vinVND  (ceil)
      const ONE = ethers.BigNumber.from('1000000000000000000');
      vinPerVND = ONE.mul(1).add(vinVND-1).div(vinVND); // ceil(1e18 / vinVND)
    }catch(e){
      console.warn('Price fetch error:', e);
      $('#vinPrice').textContent = 'Loading price...';
      vinVND = null; vinPerVND = null;
    }
  }

  // keep price updated
  async function priceLoop(){
    while(true){
      await fetchVinPrice();
      await sleep(30_000);
    }
  }

  // --------------------------- Registration & Menu ---------------------------
  async function setupMenuByRegistration(){
    try{
      const isReg = await muaban.registered(userAddr);
      $('#menuBox').classList.remove('hidden');
      if(!isReg){
        $('#btnRegister').classList.remove('hidden');
        $('#btnCreate').classList.add('hidden');
        $('#btnOrdersBuy').classList.add('hidden');
        $('#btnOrdersSell').classList.add('hidden');
      }else{
        $('#btnRegister').classList.add('hidden');
        $('#btnCreate').classList.remove('hidden');
        $('#btnOrdersBuy').classList.remove('hidden');
        $('#btnOrdersSell').classList.remove('hidden');
      }
    }catch(e){
      console.error(e);
    }
  }

  async function onRegister(){
    try{
      if(!muaban) return;
      const regFee = await muaban.REG_FEE();                 // 0.001 VIN (wei)
      const spender = MUABAN_ADDR;
      // ensure allowance
      const curAllowance = await vinToken.allowance(userAddr, spender);
      if(curAllowance.lt(regFee)){
        const txA = await vinToken.approve(spender, regFee);
        toast('Đang gửi approve 0.001 VIN…');
        await txA.wait();
      }
      const tx = await muaban.payRegistration();
      toast('Đăng ký ví đang xử lý…');
      await tx.wait();
      toast('Đăng ký thành công!');
      await setupMenuByRegistration();
      await refreshBalances();
    }catch(e){
      console.error(e);
      toast('Không thể đăng ký: Ví/RPC trả lỗi. Vui lòng kiểm tra: đã kết nối ví, đúng mạng VIC, đủ VIC/VIN và thử lại.');
    }
  }

  // --------------------------- Product: Create / Update ---------------------------
  function bindCreateModal(){
    $('#btnCreate')?.addEventListener('click', ()=>{
      // reset fields
      $('#createName').value   = '';
      $('#createIPFS').value   = '';
      $('#createUnit').value   = '';
      $('#createPrice').value  = '';
      $('#createWallet').value = userAddr || '';
      $('#createDays').value   = '3';
      openModal('#formCreate');
    });
    // close buttons
    $$('#formCreate .close').forEach(btn => btn.addEventListener('click', closeModals));
    $('#btnSubmitCreate')?.addEventListener('click', onSubmitCreate);
  }

async function onSubmitCreate(){
  try{
    if(!muaban || !signer) return toast('Chưa kết nối ví.', 'warn');

    // 1) Đã đăng ký chưa?
    const isReg = await muaban.registered(userAddr);
    if(!isReg){
      return toast('Bạn chưa đăng ký ví (0.001 VIN). Bấm nút "Đăng ký" trước khi đăng sản phẩm.', 'warn');
    } // onlyRegistered -> NOT_REGISTERED nếu bỏ qua  :contentReference[oaicite:3]{index=3}

    // 2) Lấy và kiểm tra dữ liệu form
    const name  = ($('#createName').value||'').trim();
    const img   = ($('#createIPFS').value||'').trim();
    const unit  = ($('#createUnit').value||'').trim();
    const price = $('#createPrice').value?.trim();
    const payout= ($('#createWallet').value||'').trim();
    const days  = $('#createDays').value?.trim();

    if(!name || name.length>500) return toast('Tên sản phẩm phải có (≤500 ký tự).');
    if(!price || !/^\d+$/.test(price)) return toast('Giá VNĐ phải là số nguyên > 0.');
    const priceVND = ethers.BigNumber.from(price);
    if(priceVND.lte(0)) return toast('Giá VNĐ phải > 0.');

    const deliveryDaysMax = Number(days||'0');
    if(!(deliveryDaysMax>0)) return toast('Thời gian giao hàng (ngày) phải > 0.');

    if(!ethers.utils.isAddress(payout)) return toast('Ví nhận thanh toán không hợp lệ.');

    // 3) Map field theo ABI: descriptionCID = đơn vị; imageCID = link IPFS
    const descriptionCID = unit;       // :contentReference[oaicite:4]{index=4}
    const imageCID       = img;
    const active         = true;

    // 4) callStatic trước để bắt REVERT reason chuẩn
    try{
      await muaban.callStatic.createProduct(
        name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payout, active
      );
    }catch(err){
      const msg = (err?.error?.message || err?.data?.message || err?.message || '').toUpperCase();
      if(msg.includes('NOT_REGISTERED'))     return toast('Chưa đăng ký ví: bấm "Đăng ký" (0.001 VIN) trước khi đăng.', 'warn');  // :contentReference[oaicite:5]{index=5}
      if(msg.includes('PRICE_REQUIRED'))     return toast('Giá VNĐ phải > 0.', 'warn');                                            // :contentReference[oaicite:6]{index=6}
      if(msg.includes('DELIVERY_REQUIRED'))  return toast('Thời gian giao hàng (ngày) phải > 0.', 'warn');                          // :contentReference[oaicite:7]{index=7}
      if(msg.includes('PAYOUT_WALLET_ZERO')) return toast('Ví nhận thanh toán không được để trống.', 'warn');                       // :contentReference[oaicite:8]{index=8}
      // Nếu revert khác:
      return toast('Hợp đồng từ chối giao dịch: ' + (err?.data?.message || err?.message || 'Lý do không xác định'));
    }

    // 5) Ước lượng gas + gửi giao dịch
    const gasEst = await muaban.estimateGas.createProduct(
      name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payout, active
    );
    const tx = await muaban.createProduct(
      name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payout, active,
      { gasLimit: gasEst.mul(120).div(100) }
    );
    toast('Đang đăng sản phẩm…');
    await tx.wait();

    closeModals();
    await loadProducts();
    toast('Đăng sản phẩm thành công!');
  }catch(e){
    console.error(e);
    const raw = (e?.data?.message || e?.error?.message || e?.message || '').toUpperCase();
    if(raw.includes('NOT_REGISTERED'))     return toast('Bạn chưa đăng ký ví. Bấm "Đăng ký" để trả phí 0.001 VIN.', 'warn');
    if(raw.includes('PRICE_REQUIRED'))     return toast('Giá VNĐ phải > 0.', 'warn');
    if(raw.includes('DELIVERY_REQUIRED'))  return toast('Thời gian giao hàng (ngày) phải > 0.', 'warn');
    if(raw.includes('PAYOUT_WALLET_ZERO')) return toast('Ví nhận thanh toán không được để trống.', 'warn');

    // fallback
    toast('Không thể đăng sản phẩm: lỗi giao dịch / RPC. Kiểm tra: đã kết nối ví, đúng mạng VIC, đủ VIC phí gas, đã Đăng ký ví.');
  }
}

  // Update modal
  function bindUpdateModal(){
    $$('#formUpdate .close').forEach(btn => btn.addEventListener('click', closeModals));
    $('#btnSubmitUpdate')?.addEventListener('click', onSubmitUpdate);
  }

  async function openUpdateModal(product){
    $('#updatePid').value   = String(product.productId);
    $('#updatePrice').value = String(product.priceVND || 0);
    $('#updateDays').value  = String(product.deliveryDaysMax || 1);
    $('#updateWallet').value= product.payoutWallet || '';
    $('#updateActive').checked = !!product.active;
    openModal('#formUpdate');
  }

  async function onSubmitUpdate(){
    try{
      const pid   = Number($('#updatePid').value||'0');
      const price = ethers.BigNumber.from($('#updatePrice').value||'0');
      const days  = Number($('#updateDays').value||'0');
      const payTo = ($('#updateWallet').value||'').trim();
      const active= !!$('#updateActive').checked;

      if(!(pid>0)) return toast('Thiếu productId.');
      if(!price.gt(0)) return toast('Giá phải > 0.');
      if(!(days>0)) return toast('Ngày giao hàng phải > 0.');
      if(!ethers.utils.isAddress(payTo)) return toast('Ví nhận thanh toán không hợp lệ.');

      const tx = await muaban.updateProduct(pid, price, days, payTo, active);
      toast('Đang cập nhật sản phẩm…');
      await tx.wait();
      closeModals();
      await loadProducts();
      toast('Cập nhật thành công!');
    }catch(e){
      console.error(e);
      toast('Không thể cập nhật: lỗi giao dịch.');
    }
  }

  // --------------------------- Buy / Orders ---------------------------
  function bindBuyModal(){
    $$('#formBuy .close').forEach(btn => btn.addEventListener('click', closeModals));
    $('#buyQty').addEventListener('input', updateBuyTotal);
    $('#btnSubmitBuy').addEventListener('click', onSubmitBuy);
  }

  let buyContext = null; // {product, quantity}
  function openBuyModal(product){
    buyContext = { product, quantity: 1 };
    $('#buyProductInfo').innerHTML = `
      <div><b>${escapeHtml(product.name || '')}</b></div>
      <div>Giá: <span class="order-strong">${fmtVND(product.priceVND)} VND</span> / <span class="unit">${escapeHtml(product.descriptionCID||'-')}</span></div>
    `;
    $('#buyName').value = '';
    $('#buyAddress').value = '';
    $('#buyPhone').value = '';
    $('#buyNote').value = '';
    $('#buyQty').value = '1';
    updateBuyTotal();
    openModal('#formBuy');
  }

  function updateBuyTotal(){
    const qty = Number($('#buyQty').value || '1');
    const totalVND = (buyContext?.product?.priceVND || 0) * (qty>0?qty:1);
    const txt = vinVND ? `${fmtVND(totalVND / vinVND)} VIN (ước tính)` : 'Vui lòng đợi giá VIN…';
    $('#buyTotalVIN').textContent = `Tổng VIN cần trả: ${txt}`;
  }

  async function onSubmitBuy(){
    try{
      if(!muaban || !vinPerVND) return toast('Chưa có tỷ giá VIN/VND. Đợi vài giây và thử lại.');

      const qty = Math.max(1, Number($('#buyQty').value||'1'));
      const name = $('#buyName').value.trim();
      const addr = $('#buyAddress').value.trim();
      const phone= $('#buyPhone').value.trim();
      const note = $('#buyNote').value.trim();

      if(!name || !addr || !phone) return toast('Vui lòng nhập Họ tên / Địa chỉ / SĐT.');

      const cipher = encodeBuyerInfo({name: name, address: addr, phone: phone, note: note});

      // Estimate vinAmount off-chain to ensure allowance (ceil)
      const totalVND = ethers.BigNumber.from(String(buyContext.product.priceVND)).mul(qty);
      const vinAmountEst = totalVND.mul(vinPerVND); // ceil already applied in vinPerVND

      // Ensure allowance to MUABAN_ADDR
      const curAllow = await vinToken.allowance(userAddr, MUABAN_ADDR);
      if(curAllow.lt(vinAmountEst)){
        const txA = await vinToken.approve(MUABAN_ADDR, vinAmountEst);
        toast('Đang gửi approve VIN cho đơn hàng…');
        await txA.wait();
      }

      const tx = await muaban.placeOrder(
        buyContext.product.productId,
        qty,
        vinPerVND.toString(), // uint256
        cipher
      );
      toast('Đang đặt hàng…');
      await tx.wait();
      closeModals();
      await refreshBalances();
      toast('Đặt hàng thành công! Bạn có thể theo dõi trong mục Đơn hàng mua.');
    }catch(e){
      console.error(e);
      toast('Không thể đặt hàng: Internal JSON-RPC error (hoặc thiếu VIC gas / VIN).');
    }
  }

  async function loadOrdersForBuyer(){
    if(!userAddr) return;
    const list = [];
    for(let oid=1; oid<=MAX_ORDER_SCAN; oid++){
      try{
        const o = await muaban.getOrder(oid);
        if(o && o.orderId && o.buyer && o.buyer.toLowerCase() === userAddr.toLowerCase()){
          list.push(o);
        }
      }catch{ /* stop when out-of-range is fine */ }
    }
    renderOrders('#ordersBuyList', list, 'buyer');
  }

  async function loadOrdersForSeller(){
    if(!userAddr) return;
    const list = [];
    for(let oid=1; oid<=MAX_ORDER_SCAN; oid++){
      try{
        const o = await muaban.getOrder(oid);
        if(o && o.orderId && o.seller && o.seller.toLowerCase() === userAddr.toLowerCase()){
          list.push(o);
        }
      }catch{ }
    }
    renderOrders('#ordersSellList', list, 'seller');
  }

  function renderOrders(containerSel, orders, role){
    const box = $(containerSel);
    if(!orders.length){
      box.innerHTML = `<div class="order-card">Chưa có đơn nào.</div>`;
      return;
    }
    box.innerHTML = orders.map(o=>{
      const statusTxt = ['NONE','PLACED','RELEASED','REFUNDED'][Number(o.status)||0] || 'UNKNOWN';
      return `
        <div class="order-card">
          <div class="order-row"><span class="order-strong">Order #${o.orderId}</span> · Sản phẩm #${o.productId}</div>
          <div class="order-row">Số lượng: <span class="order-strong">${o.quantity}</span></div>
          <div class="order-row">VIN escrow: <span class="order-strong">${ethers.utils.formatEther(o.vinAmount)} VIN</span></div>
          <div class="order-row">Deadline: ${new Date(Number(o.deadline)*1000).toLocaleString()}</div>
          <div class="order-row">Trạng thái: <span class="badge">${statusTxt}</span></div>
          ${role==='buyer' && Number(o.status)===1 ? `
            <div class="card-actions">
              <button class="btn primary" data-action="confirm" data-oid="${o.orderId}">Xác nhận nhận hàng</button>
              <button class="btn" data-action="refund" data-oid="${o.orderId}">Hoàn tiền (khi quá hạn)</button>
            </div>` : ``}
        </div>`;
    }).join('');

    // bind buttons
    box.querySelectorAll('button[data-action="confirm"]').forEach(b=>{
      b.addEventListener('click', async ()=>{
        try{
          const oid = Number(b.dataset.oid);
          const tx = await muaban.confirmReceipt(oid);
          toast('Đang xác nhận nhận hàng…');
          await tx.wait();
          await loadOrdersForBuyer();
        }catch(e){ toast('Không thể xác nhận: lỗi giao dịch.'); }
      });
    });
    box.querySelectorAll('button[data-action="refund"]').forEach(b=>{
      b.addEventListener('click', async ()=>{
        try{
          const oid = Number(b.dataset.oid);
          const tx = await muaban.refundIfExpired(oid);
          toast('Đang yêu cầu hoàn tiền…');
          await tx.wait();
          await loadOrdersForBuyer();
        }catch(e){ toast('Không thể hoàn tiền (chưa quá hạn hoặc lỗi giao dịch).'); }
      });
    });
  }

  // --------------------------- Product list & search ---------------------------
  async function probeProduct(pid){
    try{
      const p = await muaban.getProduct(pid);
      if(!p || !p.productId || p.seller === ethers.constants.AddressZero) return null;
      return p;
    }catch{ return null; }
  }

  async function loadProducts(){
    const listEl = $('#productList');
    listEl.innerHTML = '<div class="product-card">Đang tải sản phẩm…</div>';

    const products = [];
    // heuristic: scan 1..MAX_PRODUCT_SCAN and collect existing ones
    let emptyStreak = 0;
    for(let pid=1; pid<=MAX_PRODUCT_SCAN; pid++){
      const p = await probeProduct(pid);
      if(p && p.productId){
        products.push(p);
        emptyStreak = 0;
      }else{
        emptyStreak++;
        if(emptyStreak >= 20 && products.length>0) break; // early stop if long gap
      }
    }

    renderProducts(products);
  }

  function renderProducts(products){
    const q = ($('#searchInput').value||'').trim().toLowerCase();
    const list = q ? products.filter(p => (p.name||'').toLowerCase().includes(q)) : products;

    if(!list.length){
      $('#productList').innerHTML = `<div class="product-card">Chưa có sản phẩm phù hợp.</div>`;
      return;
    }
    $('#productList').innerHTML = list.map(p=>{
      const isMine = userAddr && p.seller && (p.seller.toLowerCase()===userAddr.toLowerCase());
      const img = ipfsThumb(p.imageCID);
      const stockCls = p.active ? 'stock-badge' : 'stock-badge out';
      const stockTxt = p.active ? 'Còn hàng' : 'Hết hàng';
      return `
        <div class="product-card">
          <img class="product-thumb" src="${escapeHtml(img)}" onerror="this.src='';" alt="">
          <div class="product-info">
            <div class="product-top">
              <h3 class="product-title">${escapeHtml(p.name || '')}</h3>
              <span class="${stockCls}">${stockTxt}</span>
            </div>
            <div class="product-meta">
              <span class="price-vnd">${fmtVND(p.priceVND)} VND</span>
              <span class="unit">/ ${escapeHtml(p.descriptionCID||'-')}</span>
            </div>
            <div class="card-actions">
              ${isMine ? `
                <button class="btn" data-action="update" data-pid="${p.productId}">Cập nhật</button>
              ` : (p.active ? `
                <button class="btn primary" data-action="buy" data-pid="${p.productId}">Mua</button>
              ` : ``)}
            </div>
          </div>
        </div>`;
    }).join('');

    // bind buttons
    $('#productList').querySelectorAll('button[data-action="buy"]').forEach(b=>{
      b.addEventListener('click', async ()=>{
        const pid = Number(b.dataset.pid);
        const p = await muaban.getProduct(pid);
        openBuyModal(p);
      });
    });
    $('#productList').querySelectorAll('button[data-action="update"]').forEach(b=>{
      b.addEventListener('click', async ()=>{
        const pid = Number(b.dataset.pid);
        const p = await muaban.getProduct(pid);
        openUpdateModal(p);
      });
    });
  }

  // --------------------------- Search ---------------------------
  function bindSearch(){
    $('#btnSearch').addEventListener('click', loadProducts);
    $('#searchInput').addEventListener('keypress', (e)=>{ if(e.key==='Enter') loadProducts(); });
  }

  // --------------------------- Safe HTML ---------------------------
  function escapeHtml(s){
    return String(s||'').replace(/[&<>"'`=\/]/g, function(c){
      return ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','/':'&#x2F;','`':'&#x60;','=':'&#x3D;'
      })[c];
    });
  }

  // --------------------------- Bind header buttons ---------------------------
  function bindHeader(){
    $('#btnConnect')?.addEventListener('click', connect);
    $('#btnDisconnect')?.addEventListener('click', disconnect);
    $('#btnRegister')?.addEventListener('click', onRegister);

    $('#btnOrdersBuy')?.addEventListener('click', async ()=>{
      $('#ordersSellSection').classList.add('hidden');
      $('#ordersBuySection').classList.remove('hidden');
      await loadOrdersForBuyer();
      window.scrollTo({top: document.body.scrollHeight, behavior:'smooth'});
    });
    $('#btnOrdersSell')?.addEventListener('click', async ()=>{
      $('#ordersBuySection').classList.add('hidden');
      $('#ordersSellSection').classList.remove('hidden');
      await loadOrdersForSeller();
      window.scrollTo({top: document.body.scrollHeight, behavior:'smooth'});
    });
  }

  // --------------------------- Init ---------------------------
  async function init(){
    bindHeader();
    bindCreateModal();
    bindUpdateModal();
    bindBuyModal();
    bindSearch();

    // Start price loop immediately
    fetchVinPrice(); priceLoop().catch(()=>{});

    // Load initial product list (read-only; works even before wallet connects)
    // Create a read-only provider for public RPC to call view functions
    const roProvider = new ethers.providers.JsonRpcProvider('https://rpc.viction.xyz', {chainId: VIC_CHAIN_ID_DEC, name: 'viction'});
    muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, roProvider);
    vinToken = new ethers.Contract(VIN_ADDR, ERC20_ABI, roProvider);

    await loadProducts();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
