const error = document.querySelector("#error");
chrome.storage.local.get("watches").then(({watches=[]})=>{const hits=watches.filter(w=>w.triggered).length;document.querySelector("#count").textContent=`${watches.length} 个监听${hits?` · ${hits} 个已达目标`:""}`});
document.querySelector("#dashboard").onclick=()=>{chrome.tabs.create({url:chrome.runtime.getURL("dashboard.html")});window.close()};
document.querySelector("#add").onclick=async()=>{const[tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.id||!/^https?:/i.test(tab.url||""))return showError("请先打开一个商品网页，再添加价格监听。");try{await chrome.tabs.sendMessage(tab.id,{type:"START_PICKER"});window.close()}catch{showError("页面尚未准备好，请刷新商品页面后重试。")}};
function showError(message){error.textContent=message;error.hidden=false}
