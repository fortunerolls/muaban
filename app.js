/* ==========================================================================
   muaban.vin — app.js (ethers v5.7.2 UMD)
   Bản đầy đủ & cẩn thận, hạn chế “Internal JSON-RPC error.”
   - Ép mạng Viction (chainId 88)
   - Giá VIN/VND = VIC/USDT (Binance) × 100 × USDT/VND (CoinGecko)
   - Số dư VIC & VIN
   - Đăng ký ví (approve REG_FEE → payRegistration)
   - Đăng sản phẩm (preflight + estimateGas)
   - Cập nhật sản phẩm (preflight + estimateGas)
   - Đặt mua (tính vinPerVND, approve, placeOrder)
   - Liệt kê sản phẩm của tôi (getSellerProductIds → getProduct)
   - Tìm kiếm: #<id> để mở theo ID; hoặc lọc theo tên trong danh sách đã tải
   ========================================================================== */

/* ========================== 0) Hằng số ========================== */
const CHAIN_ID_DEC = 88;
const CHAIN_ID_HEX = '0x' + CHAIN_ID_DEC.toString(16);      // '0x58'
const RPC_URL = 'https://rpc.viction.xyz';
const EXPLORER = 'https://www.vicscan.xyz';

// Địa chỉ (theo index.html/footer)
const MUABAN_ADDR = '0x190FD18820498872354eED9C4C080cB365Cd12E0';
const VIN_ADDR    = '0x941F63807401efCE8afe3C9d88d368bAA287Fac4';

/* ========================== 1) ABI (rút gọn các hàm dùng) ========================== */
const MUABAN_ABI = [
  {"inputs":[{"internalType":"address","name":"vinToken","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},
  {"inputs":[],"name":"REG_FEE","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"payRegistration","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[
    {"internalType":"string","name":"name","type":"string"},
    {"internalType":"string","name":"descriptionCID","type":"string"},
    {"internalType":"string","name":"imageCID","type":"string"},
    {"internalType":"uint256","name":"priceVND","type":"uint256"},
    {"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},
    {"internalType":"address","name":"payoutWallet","type":"address"},
    {"internalType":"bool","name":"active","type":"bool"}],
   "name":"createProduct","outputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[
    {"internalType":"uint256","name":"pid","type":"uint256"},
    {"internalType":"uint256","name":"priceVND","type":"uint256"},
    {"internalType":"uint32","name":"deliveryDaysMax","type":"uint32"},
    {"internalType":"address","name":"payoutWallet","type":"address"},
    {"internalType":"bool","name":"active","type":"bool"}],
   "name":"updateProduct","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"}],
   "name":"getProduct","outputs":[{"components":[
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
  {"inputs":[
    {"internalType":"uint256","name":"productId","type":"uint256"},
    {"internalType":"uint256","name":"quantity","type":"uint256"},
    {"internalType":"uint256","name":"vinPerVND","type":"uint256"},
    {"internalType":"string","name":"buyerInfoCipher","type":"string"}],
   "name":"placeOrder","outputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"registered","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"}
];

const ERC20_ABI = [
  {"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}
];

/* ========================== 2) Helpers ========================== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const short = (addr) => addr ? (addr.slice(0,6) + '…' + addr.slice(-4)) : '';

function fmtVND(n){ try{ return new Intl.NumberFormat('vi-VN').format(Number(n)); }catch{ return String(n); } }
function toast(msg, type='info'){ console.log('[toast]', type, msg); try{ alert(msg); }catch{} }
function setHidden(el, hidden=true){ if(!el) return; el.classList.toggle('hidden', hidden); }
function escapeHtml(str){ return String(str).replace(/[&<>"'`=\/]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','/':'&#x2F;','`':'&#x60;','=':'&#x3D;'}[s])); }

/* ========================== 3) State runtime ========================== */
let provider = null, signer = null, account = null;
let vin, muaban;
let lastVinPerVNDWei = null;   // BigNumber(wei/VND)
let lastVNDPerVIN = null;      // number VND/VIN

let myProductIds = [];         // uint256[]
let myProducts = [];           // [{...Product}]

/* ========================== 4) Kết nối & ép mạng ========================== */
async function ensureViction(){
  const eth = window.ethereum;
  if(!eth){ toast('Không tìm thấy ví. Vui lòng cài MetaMask.', 'warn'); return false; }
  const chainId = await eth.request({ method: 'eth_chainId' });
  if(chainId === CHAIN_ID_HEX) return true;
  try{
    await eth.request({ method:'wallet_switchEthereumChain', params:[{ chainId: CHAIN_ID_HEX }] });
    return true;
  }catch(err){
    if(err && err.code === 4902){
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN_ID_HEX,
          chainName: 'Viction Mainnet',
          nativeCurrency: { name:'VIC', symbol:'VIC', decimals:18 },
          rpcUrls: [RPC_URL],
          blockExplorerUrls: [EXPLORER]
        }]
      });
      return true;
    }
    console.error('switch chain error:', err);
    toast('Vui lòng chuyển sang mạng Viction (chainId 88).', 'warn');
    return false;
  }
}

async function connectWallet(){
  try{
    const eth = window.ethereum;
    if(!eth) return toast('Không tìm thấy ví. Vui lòng cài MetaMask.', 'warn');
    provider = new ethers.providers.Web3Provider(eth, 'any');

    const ok = await ensureViction();
    if(!ok) return;

    await provider.send('eth_requestAccounts', []);
    signer = provider.getSigner();
    account = await signer.getAddress();

    vin    = new ethers.Contract(VIN_ADDR,    ERC20_ABI, signer);
    muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);

    eth.removeAllListeners?.('chainChanged');
    eth.removeAllListeners?.('accountsChanged');
    eth.on?.('chainChanged', () => location.reload());
    eth.on?.('accountsChanged', () => location.reload());

    $('#btnConnect')?.classList.add('connected');
    if($('#btnConnect')) $('#btnConnect').textContent = 'Đã kết nối';
    setHidden($('#walletBox'), false);
    setHidden($('#menuBox'), false);

    const link = `${EXPLORER}/address/${account}`;
    if($('#accountShort')){ $('#accountShort').textContent = short(account); $('#accountShort').href = link; }

    await refreshBalances();
    await refreshRegistrationState();
    await loadMyProducts();        // tải danh sách sản phẩm của tôi
  }catch(e){
    console.error('connect error:', e);
    toast('Kết nối ví thất bại: ' + parseReadableError(e), 'warn');
  }
}

function disconnectUI(){
  provider = signer = null; account = null;
  $('#btnConnect')?.classList.remove('connected');
  if($('#btnConnect')) $('#btnConnect').textContent = 'Kết nối ví';
  setHidden($('#walletBox'), true);
  // Không ẩn menuBox để khách vẫn xem giao diện/giá
}

/* ========================== 5) Giá VIN/VND ========================== */
async function fetchPrices(){
  let vicUsdt = null, usdtVnd = null;
  try{
    const r1 = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT', { cache:'no-store' });
    const j1 = await r1.json();
    if(j1 && j1.price) vicUsdt = Number(j1.price);
  }catch(e){ console.warn('[price] binance error', e); }

  try{
    const r2 = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd', { cache:'no-store' });
    const j2 = await r2.json();
    if(j2?.tether?.vnd) usdtVnd = Number(j2.tether.vnd);
  }catch(e){ console.warn('[price] coingecko error', e); }

  if(!(vicUsdt>0) || !(usdtVnd>0)){
    if($('#vinPrice')) $('#vinPrice').textContent = 'Loading price...';
    return null;
  }

  const vndPerVIN = vicUsdt * 100 * usdtVnd;  // 1 VIN = ? VND
  lastVNDPerVIN = vndPerVIN;

  // wei/VND
  const weiPerVND = ethers.BigNumber.from('1000000000000000000')
    .div(Math.max(1, Math.floor(vndPerVIN)));
  lastVinPerVNDWei = weiPerVND;

  if($('#vinPrice')) $('#vinPrice').textContent = `1 VIN = ${fmtVND(Math.round(vndPerVIN))} VND`;
  return { vndPerVIN, weiPerVND };
}

/* ========================== 6) Số dư ========================== */
async function refreshBalances(){
  if(!provider || !account) return;
  try{
    const vic = await provider.getBalance(account);
    if($('#vicBalance')) $('#vicBalance').textContent = 'VIC: ' + ethers.utils.formatUnits(vic, 18);
  }catch(e){ console.warn('VIC balance error:', e); }

  try{
    const vinBal = await vin.balanceOf(account);
    if($('#vinBalance')) $('#vinBalance').textContent = 'VIN: ' + ethers.utils.formatUnits(vinBal, 18);
  }catch(e){ console.warn('VIN balance error:', e); }
}

/* ========================== 7) Đăng ký ví ========================== */
async function isRegistered(addr){
  try{ return !!(await muaban.registered(addr)); }catch{ return false; }
}
async function refreshRegistrationState(){
  if(!account || !muaban) return;
  const ok = await isRegistered(account);
  setHidden($('#btnRegister'), ok);     // ẩn nếu đã đăng ký
  setHidden($('#btnCreate'), !ok);      // cho phép đăng SP khi đã đăng ký
  setHidden($('#btnOrdersBuy'), !ok);
  setHidden($('#btnOrdersSell'), !ok);
}
async function ensureAllowance(spender, needed){
  const cur = await vin.allowance(account, spender);
  if(cur.gte(needed)) return true;
  const extra = needed.mul(120).div(100);
  const tx = await vin.approve(spender, extra);
  toast('Đang approve VIN…');
  await tx.wait();
  return true;
}
async function onRegister(){
  try{
    if(!signer) return toast('Vui lòng kết nối ví.');
    const regFee = await muaban.REG_FEE();
    await ensureAllowance(MUABAN_ADDR, regFee);
    const tx = await muaban.payRegistration();
    toast('Đang đăng ký…');
    await tx.wait();
    toast('Đăng ký thành công!');
    await refreshRegistrationState();
  }catch(e){
    console.error('register error:', e);
    toast('Đăng ký thất bại: ' + parseReadableError(e), 'warn');
  }
}

/* ========================== 8) Đăng sản phẩm ========================== */
function openModal(id){ const el = $(id); if(!el) return; el.classList.remove('hidden'); document.body.classList.add('no-scroll'); }
function closeModals(){ $$('.modal').forEach(m=>m.classList.add('hidden')); document.body.classList.remove('no-scroll'); }

async function onOpenCreate(){
  if(!signer) return toast('Vui lòng kết nối ví.');
  const ok = await isRegistered(account);
  if(!ok) return toast('Bạn chưa đăng ký. Vui lòng bấm "Đăng ký".');
  openModal('#formCreate');
}

async function onSubmitCreate(){
  try{
    if(!signer) return toast('Vui lòng kết nối ví.');
    const network = await signer.provider.getNetwork();
    if(Number(network.chainId)!==CHAIN_ID_DEC){
      const ok = await ensureViction();
      if(!ok) return;
    }
    const okReg = await isRegistered(account);
    if(!okReg) return toast('Bạn chưa đăng ký. Vui lòng bấm "Đăng ký".');

    const name   = ($('#createName')?.value||'').trim();
    const ipfs   = ($('#createIPFS')?.value||'').trim();
    const price  = ethers.BigNumber.from(($('#createPrice')?.value||'0').toString());
    const wallet = ($('#createWallet')?.value||'').trim();
    const days   = Number(($('#createDays')?.value||'0'));

    if(!name) return toast('Vui lòng nhập Tên sản phẩm.');
    if(!ipfs) return toast('Vui lòng nhập link IPFS.');
    if(price.lte(0)) return toast('Giá bán VNĐ phải > 0.');
    if(!wallet || !wallet.startsWith('0x') || wallet.length!==42) return toast('Ví nhận không hợp lệ.');
    if(!(days>0)) return toast('Thời gian giao hàng (ngày) phải > 0.');

    // Preflight
    try{
      await muaban.callStatic.createProduct(name, ipfs, ipfs, price, days, wallet, true);
    }catch(pre){
      console.error('[create preflight failed]', pre);
      throw new Error('Preflight lỗi: ' + parseReadableError(pre));
    }
    // estimateGas
    let gasLimit;
    try{
      const est = await muaban.estimateGas.createProduct(name, ipfs, ipfs, price, days, wallet, true);
      gasLimit = est.mul(120).div(100);
    }catch(eg){ console.warn('estimateGas lỗi, dùng 500k:', eg); gasLimit = ethers.BigNumber.from(500_000); }

    const tx = await muaban.createProduct(name, ipfs, ipfs, price, days, wallet, true, { gasLimit });
    toast('Đang đăng sản phẩm… Tx: '+tx.hash);
    await tx.wait();
    toast('Đăng sản phẩm thành công!');
    // reset
    $('#createName').value=''; $('#createIPFS').value=''; $('#createPrice').value=''; $('#createWallet').value=''; $('#createDays').value='';
    closeModals();
    // refresh list
    await loadMyProducts();
  }catch(e){
    console.error('create error:', e);
    toast('Không thể đăng sản phẩm: ' + parseReadableError(e), 'warn');
  }
}

/* ========================== 9) Cập nhật sản phẩm ========================== */
function onOpenUpdateWith(pid, product){
  if($('#updatePid')) $('#updatePid').value = String(pid||'');
  if($('#updatePrice')) $('#updatePrice').value = product ? String(product.priceVND||'') : '';
  if($('#updateDays')) $('#updateDays').value = product ? String(product.deliveryDaysMax||'') : '';
  if($('#updateWallet')) $('#updateWallet').value = product ? String(product.payoutWallet||'') : '';
  if($('#updateActive')) $('#updateActive').checked = !!(product ? product.active : true);
  openModal('#formUpdate');
}
async function onSubmitUpdate(){
  try{
    if(!signer) return toast('Vui lòng kết nối ví.');
    const pid    = ethers.BigNumber.from(($('#updatePid')?.value||'0').toString());
    const price  = ethers.BigNumber.from(($('#updatePrice')?.value||'0').toString());
    const days   = Number(($('#updateDays')?.value||'0'));
    const wallet = ($('#updateWallet')?.value||'').trim();
    const active = !!$('#updateActive')?.checked;

    if(pid.lte(0)) return toast('PID không hợp lệ.');
    if(price.lte(0)) return toast('Giá VNĐ phải > 0.');
    if(!(days>0)) return toast('Ngày giao hàng phải > 0.');
    if(!wallet || !wallet.startsWith('0x') || wallet.length!==42) return toast('Ví nhận không hợp lệ.');

    // preflight
    try{
      await muaban.callStatic.updateProduct(pid, price, days, wallet, active);
    }catch(pre){
      console.error('[update preflight failed]', pre);
      throw new Error('Preflight lỗi: ' + parseReadableError(pre));
    }
    let gasLimit;
    try{
      const est = await muaban.estimateGas.updateProduct(pid, price, days, wallet, active);
      gasLimit = est.mul(120).div(100);
    }catch(eg){ console.warn('estimateGas lỗi, dùng 400k:', eg); gasLimit = ethers.BigNumber.from(400_000); }

    const tx = await muaban.updateProduct(pid, price, days, wallet, active, { gasLimit });
    toast('Đang cập nhật… Tx: ' + tx.hash);
    await tx.wait();
    toast('Cập nhật thành công!');
    closeModals();
    await loadMyProducts();
  }catch(e){
    console.error('update error:', e);
    toast('Không thể cập nhật: ' + parseReadableError(e), 'warn');
  }
}

/* ========================== 10) Mua hàng ========================== */
let currentBuy = { productId:null, priceVND:null, name:'', unit:'', qty:1 };
function openBuyModal(product){
  currentBuy = { ...product, qty:1 };
  if($('#buyProductInfo')){
    $('#buyProductInfo').innerHTML = `<div class="product-top">
      <div class="product-title">${escapeHtml(product.name||'')}</div>
      <div class="price-vnd">${fmtVND(product.priceVND||0)} VND</div>
    </div>`;
  }
  if($('#buyQty')) $('#buyQty').value = '1';
  if($('#buyTotalVIN')) $('#buyTotalVIN').textContent = 'Tổng VIN cần trả: 0';
  openModal('#formBuy');
}
async function calcTotalVIN(qty){
  if(!lastVinPerVNDWei || !currentBuy.priceVND) return '0';
  const totalVND = ethers.BigNumber.from(String(currentBuy.priceVND)).mul(ethers.BigNumber.from(String(qty)));
  const totalWei = totalVND.mul(lastVinPerVNDWei);
  return ethers.utils.formatUnits(totalWei, 18);
}
async function updateBuyTotal(){
  const qty = Number($('#buyQty')?.value || '1');
  const total = await calcTotalVIN(qty);
  if($('#buyTotalVIN')) $('#buyTotalVIN').textContent = 'Tổng VIN cần trả: ' + total;
}
function softCipherBuyerInfo(obj){
  try{ return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }catch{ return ''; }
}
async function onSubmitBuy(){
  try{
    if(!signer) return toast('Vui lòng kết nối ví.');
    const okReg = await isRegistered(account);
    if(!okReg) return toast('Bạn chưa đăng ký. Vui lòng bấm "Đăng ký".');

    // Đảm bảo có tỷ giá
    const rate = lastVinPerVNDWei || (await fetchPrices())?.weiPerVND;
    if(!rate || ethers.BigNumber.from(rate).lte(0)) return toast('Chưa có tỷ giá. Vui lòng đợi cập nhật giá.');

    const name = ($('#buyName')?.value||'').trim();
    const addr = ($('#buyAddress')?.value||'').trim();
    const phone= ($('#buyPhone')?.value||'').trim();
    const note = ($('#buyNote')?.value||'').trim();
    const qty  = ethers.BigNumber.from($('#buyQty')?.value || '1');
    if(!currentBuy.productId) return toast('Thiếu productId.');
    if(!name || !addr || !phone) return toast('Vui lòng điền Họ tên / Địa chỉ / SĐT.');
    if(qty.lte(0)) return toast('Số lượng phải > 0.');

    const totalVND = ethers.BigNumber.from(String(currentBuy.priceVND)).mul(qty);
    const vinAmount = totalVND.mul(ethers.BigNumber.from(rate));

    await ensureAllowance(MUABAN_ADDR, vinAmount);

    // preflight placeOrder
    const infoCipher = softCipherBuyerInfo({ name, addr, phone, note, ts: Date.now() });
    try{
      await muaban.callStatic.placeOrder(
        ethers.BigNumber.from(String(currentBuy.productId)),
        qty, ethers.BigNumber.from(rate), infoCipher
      );
    }catch(pre){
      console.error('[buy preflight failed]', pre);
      throw new Error('Preflight lỗi: ' + parseReadableError(pre));
    }
    let gasLimit;
    try{
      const est = await muaban.estimateGas.placeOrder(
        ethers.BigNumber.from(String(currentBuy.productId)),
        qty, ethers.BigNumber.from(rate), infoCipher
      );
      gasLimit = est.mul(120).div(100);
    }catch(eg){ console.warn('estimateGas lỗi, dùng 500k:', eg); gasLimit = ethers.BigNumber.from(500_000); }

    const tx = await muaban.placeOrder(
      ethers.BigNumber.from(String(currentBuy.productId)), qty, ethers.BigNumber.from(rate), infoCipher,
      { gasLimit }
    );
    toast('Đang đặt mua… Tx: ' + tx.hash);
    await tx.wait();
    toast('Đặt mua thành công!');
    closeModals();
  }catch(e){
    console.error('buy error:', e);
    toast('Không thể đặt mua: ' + parseReadableError(e), 'warn');
  }
}

/* ========================== 11) Danh sách sản phẩm của tôi & hiển thị ========================== */
function ipfsUrl(cid){
  if(!cid) return '';
  if(/^ipfs:\/\//i.test(cid)) return `https://ipfs.io/ipfs/${cid.replace(/^ipfs:\/\//i,'')}`;
  if(/^https?:\/\//i.test(cid)) return cid;
  return `https://ipfs.io/ipfs/${cid}`;
}
function productCard(p){
  const img = p.imageCID ? `<div class="thumb"><img src="${escapeHtml(ipfsUrl(p.imageCID))}" alt=""/></div>` : '';
  const activeBadge = p.active ? '' : `<div class="badge off">TẠM KHÓA</div>`;
  const pid = String(p.productId||p.pid||'');
  return `<div class="product-card">
    ${img}${activeBadge}
    <div class="title">${escapeHtml(p.name||'No name')}</div>
    <div class="price">Giá: ${fmtVND(p.priceVND||0)} VND</div>
    <div class="actions">
      <button class="btn buy" data-action="buy" data-pid="${pid}">Mua</button>
      <button class="btn outline" data-action="update" data-pid="${pid}">Cập nhật</button>
      <a class="link" href="${EXPLORER}/address/${p.payoutWallet}" target="_blank" rel="noopener">Ví nhận</a>
    </div>
  </div>`;
}
async function loadMyProducts(){
  try{
    if(!signer || !account) return renderEmptyProducts('Vui lòng kết nối ví để xem sản phẩm của bạn.');
    const ids = await muaban.getSellerProductIds(account);
    myProductIds = Array.from(ids).map(x=>x.toString());
    myProducts = [];
    for(const id of myProductIds){
      try{
        const p = await muaban.getProduct(id);
        myProducts.push({ ...p, productId: p.productId?.toString?.() || id.toString() });
      }catch(inner){ console.warn('getProduct fail pid=', id, inner); }
    }
    renderProducts(myProducts);
  }catch(e){
    console.error('loadMyProducts error:', e);
    renderEmptyProducts('Không tải được danh sách sản phẩm.'); 
  }
}
function renderEmptyProducts(msg){
  const box = $('#productList'); if(!box) return;
  box.innerHTML = `<div class="order-card" style="grid-column:span 12;">${escapeHtml(msg||'Hiện chưa có sản phẩm.')}</div>`;
}
function renderProducts(list){
  const box = $('#productList'); if(!box) return;
  if(!list || !list.length) return renderEmptyProducts('Bạn chưa có sản phẩm nào. Hãy bấm "Đăng sản phẩm".');
  box.innerHTML = list.map(productCard).join('');
  // Gán sự kiện cho nút Mua/Cập nhật
  box.querySelectorAll('[data-action="buy"]').forEach(btn => {
    btn.addEventListener('click', async (ev)=>{
      const pid = ev.currentTarget.getAttribute('data-pid');
      const p = myProducts.find(pp => String(pp.productId) === String(pid)) || await muaban.getProduct(pid);
      openBuyModal({ productId: pid, priceVND: p.priceVND, name: p.name, unit:'' });
    });
  });
  box.querySelectorAll('[data-action="update"]').forEach(btn => {
    btn.addEventListener('click', async (ev)=>{
      const pid = ev.currentTarget.getAttribute('data-pid');
      const p = myProducts.find(pp => String(pp.productId) === String(pid)) || await muaban.getProduct(pid);
      onOpenUpdateWith(pid, p);
    });
  });
}

/* ========================== 12) Tìm kiếm ========================== */
async function onSearch(){
  const q = ($('#searchInput')?.value || '').trim();
  if(!q){ return renderProducts(myProducts); }
  // Nếu bắt đầu bằng # và là số → tra theo ID on-chain
  if(/^#?\d+$/.test(q)){
    const pid = q.replace('#','');
    try{
      const p = await muaban.getProduct(pid);
      if(p && p.productId && p.productId.toString()!=='0'){
        return renderProducts([{ ...p, productId: p.productId.toString() }]);
      }
    }catch(e){ /* ignore */ }
    return renderEmptyProducts('Không tìm thấy sản phẩm với ID ' + pid);
  }
  // Lọc client theo tên trong danh sách đã load
  const list = (myProducts||[]).filter(p => String(p.name||'').toLowerCase().includes(q.toLowerCase()));
  if(list.length) return renderProducts(list);
  return renderEmptyProducts('Không có kết quả với từ khoá "'+q+'".');
}

/* ========================== 13) Đơn hàng (placeholder thân thiện) ========================== */
function openOrders(kind){
  const sectionBuy  = $('#ordersBuySection');
  const sectionSell = $('#ordersSellSection');
  if(!sectionBuy || !sectionSell) return;
  setHidden(sectionBuy, kind!=='buy');
  setHidden(sectionSell, kind!=='sell');

  const listEl = kind==='buy' ? $('#ordersBuyList') : $('#ordersSellList');
  if(listEl){
    listEl.innerHTML = `<div class="order-card">
      Chưa có đơn hàng để hiển thị. Tính năng sẽ hoạt động đầy đủ khi có chỉ mục sự kiện.
    </div>`;
  }
  (kind==='buy'?sectionBuy:sectionSell).scrollIntoView({ behavior:'smooth' });
}

/* ========================== 14) Error parser ========================== */
function parseReadableError(e){
  try{
    const raw = (e?.error?.message || e?.data?.message || e?.reason || e?.message || '').toString();
    const lower = raw.toLowerCase();

    if (lower.includes('execution reverted:')) {
      const reason = raw.split('execution reverted:')[1]?.trim();
      if (reason) return reason;
    }
    if (lower.includes('reverted with reason string')) {
      const m = raw.match(/reverted with reason string ['"]([^'"]+)['"]/i);
      if (m && m[1]) return m[1];
    }
    if (lower.includes('reverted with custom error')) {
      const m = raw.match(/reverted with custom error '([^']+)'/i);
      if (m && m[1]) return m[1];
    }

    // Friendly mapping
    if(raw.includes('NOT_REGISTERED')) return 'Ví chưa đăng ký.';
    if(raw.includes('VIN_TRANSFER_FAIL')) return 'Không chuyển được VIN (thiếu số dư hoặc chưa approve).';
    if(raw.includes('PRICE_REQUIRED')) return 'Giá bán phải > 0.';
    if(raw.includes('DELIVERY_REQUIRED')) return 'Thời gian giao hàng phải > 0.';
    if(raw.includes('PAYOUT_WALLET_ZERO')) return 'Ví nhận thanh toán không hợp lệ.';
    if(raw.includes('PRODUCT_NOT_ACTIVE')) return 'Sản phẩm đang tạm khoá bán.';
    if(raw.includes('PRODUCT_NOT_FOUND')) return 'Không tìm thấy sản phẩm.';
    if(raw.includes('QUANTITY_REQUIRED')) return 'Số lượng phải > 0.';
    if(raw.includes('VIN_PER_VND_REQUIRED')) return 'Thiếu tỷ giá VIN/VND.';
    if(raw.includes('insufficient funds')) return 'Không đủ VIC để trả gas.';
    if(raw.includes('user rejected')) return 'Bạn đã từ chối giao dịch trong ví.';
    if(raw.includes('internal json-rpc error')) return 'Ví/RPC trả lỗi chung chung. Vui lòng kiểm tra: đã kết nối ví, đúng mạng Viction, đủ VIC phí gas, đã Đăng ký ví. Chi tiết: ' + raw.slice(0, 200);

    return raw || 'Lỗi không xác định.';
  }catch{
    return 'Lỗi không xác định.';
  }
}

/* ========================== 15) Bind DOM & Khởi động ========================== */
function renderEmptyBase(){
  renderEmptyProducts('Hãy kết nối ví để tải sản phẩm của bạn, hoặc dùng tìm kiếm #<id> để xem nhanh một sản phẩm.');
}
function bindEvents(){
  // ví
  $('#btnConnect')?.addEventListener('click', connectWallet);
  $('#btnDisconnect')?.addEventListener('click', disconnectUI);

  // menu
  $('#btnRegister')?.addEventListener('click', onRegister);
  $('#btnCreate')?.addEventListener('click', onOpenCreate);
  $('#btnOrdersBuy')?.addEventListener('click', ()=>openOrders('buy'));
  $('#btnOrdersSell')?.addEventListener('click', ()=>openOrders('sell'));

  // form create
  $('#btnSubmitCreate')?.addEventListener('click', onSubmitCreate);

  // form update
  $('#btnSubmitUpdate')?.addEventListener('click', onSubmitUpdate);

  // form buy
  $('#buyQty')?.addEventListener('input', updateBuyTotal);
  $('#btnSubmitBuy')?.addEventListener('click', onSubmitBuy);

  // search
  $('#btnSearch')?.addEventListener('click', onSearch);
  $('#searchInput')?.addEventListener('keydown', (e)=>{ if(e.key==='Enter') onSearch(); });

  // giá
  fetchPrices();
  setInterval(fetchPrices, 60_000);

  renderEmptyBase();
}
document.addEventListener('DOMContentLoaded', bindEvents);
