// ==UserScript==
// @name        Humble Bundle Steam Owned Game Flag
// @namespace   ViolentMonkeyScripts
// @match       https://www.humblebundle.com/*
// @grant       GM_xmlhttpRequest
// @connect     api.steampowered.com
// ==/UserScript==

const STEAM_API_KEY = localStorage.getItem('STEAM_API_KEY') || prompt('Enter your Steam API Key:');
const STEAM_ID = localStorage.getItem('STEAM_ID') || prompt('Enter your Steam ID:');
localStorage.setItem('STEAM_API_KEY', STEAM_API_KEY);
localStorage.setItem('STEAM_ID', STEAM_ID);

async function fetchOwnedGames() {
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${STEAM_ID}&include_appinfo=true&format=json`;

  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: url,
      onload: (response) => {
        const data = JSON.parse(response.responseText);
        if (data.response && data.response.games) {
          resolve(data.response.games);
        } else {
          reject("No games found or API error");
        }
      },
      onerror: () => reject("Failed to fetch Steam games")
    });
  });
}

function getHumbleBundleGames() {
  const gameElements = document.querySelectorAll('li.entity-block-container');
  return Array.from(gameElements).map(element => {
    const nameElement = element.querySelector("span.entity-title")
    let name = ""
    if (nameElement) {
      name = nameElement.innerText.trim();
    }
    return { element, name };
  });
}

async function flagOwnedGames() {
  try {
    const steamGames = await fetchOwnedGames();
    const humbleGames = getHumbleBundleGames();

    console.log({steamGames})

    const steamGameNames = new Set(steamGames.map(game => game.name.toLowerCase()));

    humbleGames.forEach(humbleGame => {
      if (steamGameNames.has(humbleGame.name.toLowerCase())) {
        humbleGame.element.style.position = 'relative';

        const flag = document.createElement('div');
        flag.innerText = 'Owned on Steam';
        flag.style.position = 'absolute';
        flag.style.top = '0';
        flag.style.left = '0';
        flag.style.backgroundColor = 'rgba(0, 128, 0, 0.7)';
        flag.style.color = 'white';
        flag.style.padding = '4px';

        humbleGame.element.appendChild(flag);
      }
    });
  } catch (error) {
    console.error('Error flagging games:', error);
  }
}

window.addEventListener('load', flagOwnedGames);
