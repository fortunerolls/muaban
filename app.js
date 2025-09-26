/* ==========================================================================
   muaban.vin — app.js (ethers v5.7.2 UMD)
   Mục tiêu: ổn định, rõ ràng, không "Internal JSON-RPC error." do gọi sai RPC/mạng/allowance
   Các điểm chính:
   - Kết nối ví & ép mạng Viction (chainId 88 / 0x58)
   - Lấy giá VIN theo VND = (VIC/USDT từ Binance × 100) × (USDT/VND từ CoinGecko)
   - Hiển thị số dư VIC (native) & VIN (ERC20)
   - Đăng ký ví: approve REG_FEE cho HĐ trước rồi gọi payRegistration()
   - Đăng sản phẩm: gọi createProduct(...) theo đúng ABI (dùng 1 link IPFS cho cả imageCID & descriptionCID nếu user chỉ cung cấp 1)
   - Mua hàng: khuôn mẫu đầy đủ (chỉ mở khi có danh sách sản phẩm). Vì hợp đồng chưa có liệt kê tổng sản phẩm, UI mặc định hiển thị “Chưa có sản phẩm”
   - Các nút “Đơn hàng mua / bán”: hiển thị thông báo thân thiện do ABI không có liệt kê danh sách
   - Không để lộ thông tin người bán trên card (theo góp ý)
   ========================================================================== */

/* ========================== 0) Hằng số chuỗi / địa chỉ / ABI ========================== */
const CHAIN_ID_DEC = 88;
const CHAIN_ID_HEX = '0x' + CHAIN_ID_DEC.toString(16);      // '0x58'
const RPC_URL = 'https://rpc.viction.xyz';
const EXPLORER = 'https://www.vicscan.xyz';

// Địa chỉ (theo mô tả)
const MUABAN_ADDR = '0x190FD18820498872354eED9C4C080cB365Cd12E0';
const VIN_ADDR    = '0x941F63807401efCE8afe3C9d88d368bAA287Fac4';

// ABI rút gọn theo file Muaban_ABI.json (chỉ các hàm dùng)
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
  {"inputs":[{"internalType":"uint256","name":"pid","type":"uint256"},{"internalType":"bool","name":"active","type":"bool"}],
   "name":"setProductActive","outputs":[],"stateMutability":"nonpayable","type":"function"},
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
  {"inputs":[
    {"internalType":"uint256","name":"productId","type":"uint256"},
    {"internalType":"uint256","name":"quantity","type":"uint256"},
    {"internalType":"uint256","name":"vinPerVND","type":"uint256"},
    {"internalType":"string","name":"buyerInfoCipher","type":"string"}],
   "name":"placeOrder","outputs":[{"internalType":"uint256","name":"oid","type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],"name":"confirmReceipt","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"uint256","name":"orderId","type":"uint256"}],"name":"refundIfExpired","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"","type":"address"}],"name":"registered","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"}
];

// ERC20 ABI (theo VinToken_ABI.json) — dùng các hàm phổ biến
const ERC20_ABI = [
  {"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"recipient","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transfer","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}
];

/* ========================== 1) Helpers UI ========================== */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const short = (addr) => addr ? (addr.slice(0,6) + '…' + addr.slice(-4)) : '';

function fmtVND(n){
  try{
    return new Intl.NumberFormat('vi-VN').format(Number(n));
  }catch{ return String(n); }
}
function toast(msg, type='info'){
  // gọn nhẹ: dùng alert cho chắc (tránh CSS/HTML phức tạp gây lỗi)
  console.log('[toast]', type, msg);
  try { alert(msg); } catch {}
}
function setHidden(el, hidden=true){
  if(!el) return;
  el.classList.toggle('hidden', hidden);
}

/* ========================== 2) Trạng thái runtime ========================== */
let provider = null;
let signer   = null;
let account  = null;

let vinContract = null;
let muabanContract = null;

let lastVinPerVNDWei = null;   // BigNumber(wei/VND)
let lastVNDPerVIN = null;      // number cho hiển thị

/* ========================== 3) Kết nối & ép mạng Viction ========================== */
async function ensureViction(){
  const eth = window.ethereum;
  if(!eth) { toast('Không tìm thấy ví. Vui lòng cài MetaMask.', 'warn'); return false; }
  const chainId = await eth.request({ method: 'eth_chainId' });
  if(chainId === CHAIN_ID_HEX) return true;
  try{
    await eth.request({ method:'wallet_switchEthereumChain', params:[{ chainId: CHAIN_ID_HEX }] });
    return true;
  }catch(err){
    // Nếu mạng chưa add
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
    }else{
      console.error('switch chain error:', err);
      toast('Vui lòng chuyển sang mạng Viction (chainId 88).', 'warn');
      return false;
    }
  }
}

async function connectWallet(){
  const eth = window.ethereum;
  if(!eth){ toast('Không tìm thấy ví. Vui lòng cài MetaMask.', 'warn'); return; }
  provider = new ethers.providers.Web3Provider(eth, 'any');

  const ok = await ensureViction();
  if(!ok) return;

  await provider.send('eth_requestAccounts', []);
  signer  = provider.getSigner();
  account = await signer.getAddress();

  // Khởi tạo contracts
  vinContract    = new ethers.Contract(VIN_ADDR, ERC20_ABI, signer);
  muabanContract = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);

  // Lắng nghe chuyển mạng / đổi account => refresh
  eth.removeAllListeners?.('chainChanged');
  eth.removeAllListeners?.('accountsChanged');
  eth.on?.('chainChanged', () => { location.reload(); });
  eth.on?.('accountsChanged', () => { location.reload(); });

  // Cập nhật UI
  $('#btnConnect')?.classList.add('connected');
  $('#btnConnect') && ($('#btnConnect').textContent = 'Đã kết nối');
  setHidden($('#walletBox'), false);

  const accShort = short(account);
  const link = `${EXPLORER}/address/${account}`;
  const $acc = $('#accountShort');
  if($acc){ $acc.textContent = accShort; $acc.href = link; }

  await refreshBalances();
  await refreshRegistrationState();
}

function disconnectUI(){
  // Chỉ reset trạng thái UI (không có API ngắt session trên EVM)
  provider = signer = null;
  account = null;
  $('#btnConnect') && ($('#btnConnect').textContent = 'Kết nối ví');
  $('#btnConnect')?.classList.remove('connected');
  setHidden($('#walletBox'), true);
  setHidden($('#menuBox'), true);
}

/* ========================== 4) Giá — VIN/VND ========================== */
async function fetchPrices(){
  // Lấy VIC/USDT từ Binance
  let vicUsdt = null;
  try{
    const r1 = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT', { cache:'no-store' });
    const j1 = await r1.json();
    if(j1 && j1.price) vicUsdt = Number(j1.price);
  }catch(e){ console.warn('[price] binance error', e); }

  // Lấy USDT/VND từ CoinGecko
  let usdtVnd = null;
  try{
    const r2 = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd', { cache:'no-store' });
    const j2 = await r2.json();
    if(j2 && j2.tether && j2.tether.vnd) usdtVnd = Number(j2.tether.vnd);
  }catch(e){ console.warn('[price] coingecko error', e); }

  if(!(vicUsdt>0) || !(usdtVnd>0)){
    $('#vinPrice') && ($('#vinPrice').textContent = 'Loading price...');
    return null;
  }

  // VIN/VND = VIC/USDT × 100 × USDT/VND
  const vndPerVIN = vicUsdt * 100 * usdtVnd;      // số VND cho 1 VIN
  lastVNDPerVIN = vndPerVIN;

  // vinPerVND (wei/VND) = 1e18 / vndPerVIN
  // Dùng floor để không trả thiếu (contract đã ceil khi nhân/xuất toán)
  const weiPerVND = ethers.BigNumber.from('1000000000000000000')
    .div( Math.max(1, Math.floor(vndPerVIN)) ); // tránh chia 0

  lastVinPerVNDWei = weiPerVND;

  // Cập nhật UI
  const txt = `1 VIN = ${fmtVND(Math.round(vndPerVIN))} VND`;
  $('#vinPrice') && ($('#vinPrice').textContent = txt);

  return { vndPerVIN, weiPerVND };
}

/* ========================== 5) Số dư ========================== */
async function refreshBalances(){
  if(!provider || !signer || !account) return;
  try{
    const vic = await provider.getBalance(account);
    $('#vicBalance') && ($('#vicBalance').textContent = 'VIC: ' + ethers.utils.formatUnits(vic, 18));

    const vinBal = await vinContract.balanceOf(account);
    // VIN có 18 decimals (theo hợp đồng)
    $('#vinBalance') && ($('#vinBalance').textContent = 'VIN: ' + ethers.utils.formatUnits(vinBal, 18));
  }catch(e){
    console.warn('Không đọc được số dư:', e);
    // Không ném lỗi lên UI để tránh "Internal JSON-RPC error" gây hoang mang
  }
}

/* ========================== 6) Đăng ký ví ========================== */
async function isRegistered(addr){
  try{
    const ok = await muabanContract.registered(addr);
    return !!ok;
  }catch(e){ return false; }
}
async function refreshRegistrationState(){
  if(!account || !muabanContract) return;
  const ok = await isRegistered(account);

  // Nếu chưa đăng ký: hiện nút Đăng ký, ẩn 3 nút còn lại
  setHidden($('#menuBox'), false);
  setHidden($('#btnRegister'), ok); // ẩn nếu đã đăng ký
  setHidden($('#btnCreate'), !ok);
  setHidden($('#btnOrdersBuy'), !ok);
  setHidden($('#btnOrdersSell'), !ok);
}

async function ensureAllowance(spender, needed){
  // Kiểm tra allowance VIN cho hợp đồng
  const cur = await vinContract.allowance(account, spender);
  if(cur.gte(needed)) return true;

  // approve đủ mức cần thiết (cộng thêm đệm 10%) để giảm số lần approve
  const extra = needed.mul(110).div(100);
  const tx = await vinContract.approve(spender, extra);
  toast('Đang approve VIN cho hợp đồng…');
  await tx.wait();
  return true;
}

async function onRegister(){
  if(!signer) return toast('Vui lòng kết nối ví.');
  const regFee = await muabanContract.REG_FEE();
  await ensureAllowance(MUABAN_ADDR, regFee);
  const tx = await muabanContract.payRegistration();
  toast('Đang đăng ký…');
  await tx.wait();
  toast('Đăng ký thành công!');
  await refreshRegistrationState();
}

/* ========================== 7) Đăng sản phẩm ========================== */
function openModal(id){
  const el = $(id);
  if(!el) return;
  el.classList.remove('hidden');
  document.body.classList.add('no-scroll');
}
function closeModals(){
  $$('.modal').forEach(m => m.classList.add('hidden'));
  document.body.classList.remove('no-scroll');
}

async function onOpenCreate(){
  if(!signer) return toast('Vui lòng kết nối ví.');
  const ok = await isRegistered(account);
  if(!ok) return toast('Bạn chưa đăng ký. Vui lòng bấm "Đăng ký" trước.');
  openModal('#formCreate');
}

// Map một trường IPFS -> cả mô tả & ảnh (nếu người dùng chỉ có 1 link)
async function onSubmitCreate(){
  try{
    if(!signer) return toast('Vui lòng kết nối ví.');
    const ok = await isRegistered(account);
    if(!ok) return toast('Bạn chưa đăng ký. Vui lòng bấm "Đăng ký" trước.');

    const name  = ($('#createName')?.value || '').trim();
    const ipfs  = ($('#createIPFS')?.value || '').trim();
    const unit  = ($('#createUnit')?.value || '').trim(); // UI hiển thị, KHÔNG lưu on-chain theo ABI hiện tại
    const price = ethers.BigNumber.from( ($('#createPrice')?.value || '0').toString() );
    const wallet= ($('#createWallet')?.value || '').trim();
    const days  = Number(($('#createDays')?.value || '0'));

    if(!name)  return toast('Vui lòng nhập Tên sản phẩm.');
    if(price.lte(0))  return toast('Vui lòng nhập Giá bán VNĐ > 0.');
    if(!wallet || !wallet.startsWith('0x') || wallet.length!==42) return toast('Ví nhận không hợp lệ.');
    if(!(days>0)) return toast('Vui lòng nhập Thời gian giao hàng (ngày) > 0.');

    // ABI createProduct(name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active)
    // Dùng cùng IPFS cho descriptionCID & imageCID nếu chỉ cung cấp 1.
    const tx = await muabanContract.createProduct(
      name,
      ipfs,             // descriptionCID
      ipfs,             // imageCID
      price,            // priceVND (uint256)
      days,             // deliveryDaysMax (uint32)
      wallet,           // payoutWallet
      true              // active mặc định
    );
    toast('Đang đăng sản phẩm…');
    const rc = await tx.wait();
    // Có thể lấy pid từ event ProductCreated nếu cần, ở đây chỉ thông báo
    toast('Đăng sản phẩm thành công!');

    // Reset form nhẹ nhàng
    $('#createName').value = '';
    $('#createIPFS').value = '';
    $('#createUnit').value = '';
    $('#createPrice').value = '';
    $('#createWallet').value = '';
    $('#createDays').value = '';
    closeModals();
  }catch(e){
    console.error('create product error:', e);
    const msg = parseReadableError(e);
    toast('Không thể đăng sản phẩm: ' + msg, 'warn');
  }
}

/* ========================== 8) Mua hàng ========================== */
let currentBuy = { productId:null, priceVND:null, name:'', unit:'', qty:1 };

function openBuyModal(product){
  currentBuy = { ...product, qty:1 };
  const $info = $('#buyProductInfo');
  if($info){
    $info.innerHTML = `<div class="product-top">
        <div class="product-title">${escapeHtml(product.name)}</div>
        <div class="price-vnd">${fmtVND(product.priceVND)} VND${product.unit ? ' / ' + escapeHtml(product.unit) : ''}</div>
      </div>`;
  }
  $('#buyQty').value = '1';
  $('#buyTotalVIN').textContent = 'Tổng VIN cần trả: 0';
  openModal('#formBuy');
}

function escapeHtml(str){
  return String(str).replace(/[&<>"'`=\/]/g, s => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','/':'&#x2F;','`':'&#x60;','=':'&#x3D;'
  }[s]));
}

async function calcTotalVIN(qty){
  if(!lastVinPerVNDWei || !currentBuy.priceVND) return '0';
  const q = ethers.BigNumber.from(String(qty));
  const totalVND = ethers.BigNumber.from(String(currentBuy.priceVND)).mul(q);
  const totalWei = totalVND.mul(lastVinPerVNDWei); // hợp đồng sẽ ceil nội bộ
  return ethers.utils.formatUnits(totalWei, 18);
}

async function updateBuyTotal(){
  const qty = Number($('#buyQty').value || '1');
  const total = await calcTotalVIN(qty);
  $('#buyTotalVIN').textContent = 'Tổng VIN cần trả: ' + total;
}

function softCipherBuyerInfo(obj){
  // Thay cho mã hóa thật sự: base64 JSON (đủ để hợp đồng nhận string, không lỗi)
  try{
    return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
  }catch{ return ''; }
}

async function onSubmitBuy(){
  try{
    if(!signer) return toast('Vui lòng kết nối ví.');
    const ok = await isRegistered(account);
    if(!ok) return toast('Bạn chưa đăng ký. Vui lòng bấm "Đăng ký" trước.');

    // Bắt buộc cần có tỷ giá
    const rate = lastVinPerVNDWei || (await fetchPrices()?.weiPerVND);
    if(!rate || ethers.BigNumber.from(rate).lte(0)) return toast('Chưa có tỷ giá. Vui lòng đợi cập nhật giá.');

    const name = ($('#buyName')?.value||'').trim();
    const addr = ($('#buyAddress')?.value||'').trim();
    const phone= ($('#buyPhone')?.value||'').trim();
    const note = ($('#buyNote')?.value||'').trim();
    const qty  = ethers.BigNumber.from($('#buyQty')?.value || '1');

    if(!currentBuy.productId) return toast('Thiếu productId.');
    if(!name || !addr || !phone) return toast('Vui lòng điền Họ tên / Địa chỉ / SĐT.');
    if(qty.lte(0)) return toast('Số lượng phải > 0.');

    // Tính vinAmount ~ totalVND * rate
    const totalVND = ethers.BigNumber.from(String(currentBuy.priceVND)).mul(qty);
    const vinAmount = totalVND.mul(ethers.BigNumber.from(rate)); // 18 wei

    // approve & placeOrder
    await ensureAllowance(MUABAN_ADDR, vinAmount);

    const infoCipher = softCipherBuyerInfo({ name, addr, phone, note, ts: Date.now() });
    const tx = await muabanContract.placeOrder(
      ethers.BigNumber.from(String(currentBuy.productId)),
      qty,
      ethers.BigNumber.from(rate),
      infoCipher
    );
    toast('Đang đặt mua…');
    await tx.wait();
    toast('Đặt mua thành công!');
    closeModals();
  }catch(e){
    console.error('buy error:', e);
    toast('Không thể đặt mua: ' + parseReadableError(e), 'warn');
  }
}

/* ========================== 9) Danh sách sản phẩm & Đơn hàng (mock) ========================== */
/*
  Lưu ý: ABI hiện tại KHÔNG có hàm trả về tổng số sản phẩm hoặc mảng tất cả productId,
  nên không thể “liệt kê hết” on-chain thuần túy. Để tránh lỗi:
  - Khi chưa có chỉ mục off-chain, ta hiển thị trạng thái “Chưa có sản phẩm để hiển thị”.
  - Khi user bấm “Đơn hàng mua / bán”, hiển thị thông báo tương tự.
*/
function renderEmptyProducts(){
  const box = $('#productList');
  if(!box) return;
  box.innerHTML = `<div class="order-card" style="grid-column:span 12;">
    Hiện chưa có sản phẩm công khai để hiển thị. Khi có chỉ mục on-chain/off-chain, danh sách sẽ cập nhật tự động.
  </div>`;
}

function openOrders(kind){
  // kind = 'buy' | 'sell'
  const sectionBuy  = $('#ordersBuySection');
  const sectionSell = $('#ordersSellSection');
  if(!sectionBuy || !sectionSell) return;
  setHidden(sectionBuy, kind!=='buy');
  setHidden(sectionSell, kind!=='sell');

  const list = (kind==='buy') ? $('#ordersBuyList') : $('#ordersSellList');
  if(list){
    list.innerHTML = `<div class="order-card">
      Chưa có đơn hàng để hiển thị. Tính năng sẽ hoạt động đầy đủ khi có chỉ mục sự kiện hoặc API tổng hợp.
    </div>`;
  }
  // Cuộn tới khu vực
  (sectionBuy && !sectionBuy.classList.contains('hidden') ? sectionBuy : sectionSell).scrollIntoView({ behavior:'smooth' });
}

/* ========================== 10) Bắt sự kiện DOM ========================== */
function bindEvents(){
  // Connect / Disconnect
  $('#btnConnect')?.addEventListener('click', connectWallet);
  $('#btnDisconnect')?.addEventListener('click', disconnectUI);

  // Price ticker
  fetchPrices();
  setInterval(fetchPrices, 60_000); // 60s cập nhật 1 lần

  // Menu sau khi kết nối
  $('#btnRegister')?.addEventListener('click', onRegister);
  $('#btnCreate')?.addEventListener('click', onOpenCreate);
  $('#btnOrdersBuy')?.addEventListener('click', () => openOrders('buy'));
  $('#btnOrdersSell')?.addEventListener('click', () => openOrders('sell'));

  // Create product
  $('#btnSubmitCreate')?.addEventListener('click', onSubmitCreate);

  // Buy modal
  $('#buyQty')?.addEventListener('input', updateBuyTotal);
  $('#btnSubmitBuy')?.addEventListener('click', onSubmitBuy);

  // Close modals (nút Đóng)
  $$('#formCreate .close, #formUpdate .close, #formBuy .close').forEach(btn => btn.addEventListener('click', closeModals));

  // Render danh sách rỗng mặc định
  renderEmptyProducts();
}

/* ========================== 11) Error parser ========================== */
function parseReadableError(e){
  try{
    // ethers v5: e.error?.message hoặc e.data?.message hoặc e.message
    const raw = (e?.error?.message || e?.data?.message || e?.message || '').toString();
    if(!raw) return 'Lỗi không xác định.';

    // Một số thông báo thân thiện
    if(raw.includes('NOT_REGISTERED')) return 'Ví chưa đăng ký.';
    if(raw.includes('VIN_TRANSFER_FAIL')) return 'Không chuyển được VIN (thiếu số dư hoặc chưa approve).';
    if(raw.includes('PRICE_REQUIRED')) return 'Giá bán phải > 0.';
    if(raw.includes('DELIVERY_REQUIRED')) return 'Thời gian giao hàng phải > 0.';
    if(raw.includes('PAYOUT_WALLET_ZERO')) return 'Ví nhận thanh toán không hợp lệ.';
    if(raw.includes('PRODUCT_NOT_ACTIVE')) return 'Sản phẩm đang tạm khoá bán.';
    if(raw.includes('PRODUCT_NOT_FOUND')) return 'Không tìm thấy sản phẩm.';
    if(raw.includes('QUANTITY_REQUIRED')) return 'Số lượng phải > 0.';
    if(raw.includes('VIN_PER_VND_REQUIRED')) return 'Thiếu tỷ giá VIN/VND.';

    // RPC chung chung
    if(raw.includes('Internal JSON-RPC error')) return 'Ví/RPC trả lỗi chung chung. Vui lòng kiểm tra: đã kết nối ví, đúng mạng Viction, đủ VIC phí gas, đã Đăng ký ví.';
    if(raw.includes('insufficient funds')) return 'Không đủ VIC để trả gas.';
    if(raw.includes('user rejected')) return 'Bạn đã từ chối giao dịch trong ví.';

    return raw;
  }catch{ return 'Lỗi không xác định.'; }
}

/* ========================== 12) Khởi động ========================== */
document.addEventListener('DOMContentLoaded', bindEvents);
