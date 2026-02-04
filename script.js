const RECAPTCHA_SITE_KEY = '6LdM1F8sAAAAADLgpjEUlP9SSyoaM_0tXzBZtf-Z';

let db = null;

const requestCache = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60000;

async function rateLimitedRequest(key, requestFn) {
    const now = Date.now();
    const requests = requestCache.get(key) || [];
    const recentRequests = requests.filter(time => now - time < RATE_WINDOW);
    
    if (recentRequests.length >= RATE_LIMIT) {
        throw new Error('⏱️ Забагато запитів. Зачекайте хвилину.');
    }
    
    recentRequests.push(now);
    requestCache.set(key, recentRequests);
    
    return await requestFn();
}

document.addEventListener('DOMContentLoaded', function() {
    try {
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        
        // 2. Ініціалізація App Check (ЗАХИСТ!)
        if (typeof firebase.appCheck !== 'undefined') {
            try {
                const appCheck = firebase.appCheck();
                appCheck.activate(
                    RECAPTCHA_SITE_KEY,
                    true // autoRefresh
                );
                console.log('✅ Firebase App Check активовано');
            } catch (appCheckError) {
                console.error('❌ Помилка App Check:', appCheckError);
                updateStatus("Помилка безпеки. Перезавантажте сторінку.", 'error');
            }
        } else {
            console.error('❌ Firebase App Check не завантажено!');
            updateStatus("Помилка завантаження модулів безпеки", 'error');
        }
        
        db = firebase.firestore();
        
        // 4. Налаштування Firestore
        db.settings({
            cacheSizeBytes: firebase.firestore.CACHE_SIZE_UNLIMITED
        });
        
        // 5. Офлайн персистентність
        db.enablePersistence({ synchronizeTabs: true })
            .then(() => {
                console.log('✅ Офлайн режим увімкнено');
            })
            .catch((err) => {
                if (err.code === 'failed-precondition') {
                    console.warn('⚠️ Персистентність вже увімкнена');
                } else if (err.code === 'unimplemented') {
                    console.warn('⚠️ Браузер не підтримує персистентність');
                }
            });
        
        console.log('✅ Firebase повністю ініціалізовано');
        testFirebaseConnection();
        
    } catch (error) {
        console.error('❌ Критична помилка Firebase:', error);
        updateStatus("Помилка підключення до бази даних", 'error');
    }
});

async function testFirebaseConnection() {
    try {
        console.log('🔍 Тестування підключення до Firestore...');
        const testQuery = await db.collection('park').limit(1).get();
        console.log('✅ З\'єднання з Firestore успішне');
        console.log(`📊 Знайдено документів: ${testQuery.size}`);
        
        if (testQuery.size > 0) {
            updateStatus("База даних підключена", 'success');
        }
    } catch (error) {
        console.error('❌ Помилка Firestore:', error);
        
        if (error.code === 'permission-denied') {
            updateStatus("❌ Доступ заборонено. App Check не налаштовано!", 'error');
            console.error('Перейдіть в Firebase Console → App Check і увімкніть enforcement');
        } else if (error.code === 'unavailable') {
            console.log('📡 Працюємо в офлайн режимі');
        } else {
            updateStatus(`⚠️ Помилка: ${error.message}`, 'error');
        }
    }
}
const WIDTH_ERROR = 2.0;    
const STEP_METERS = 50;     
const MAX_SEARCH_DIST = 40; 
const DENSITY_STEP = 10;
const BUILDING_SEARCH_RADIUS = 25;
const LVIV_BOUNDS = [[49.75, 23.85], [49.95, 24.15]];

const UTM_ZONE = 34;
const UTM_FALSE_EASTING = 500000;
const UTM_FALSE_NORTHING = 0;
const UTM_SCALE_FACTOR = 0.9996;
const EARTH_RADIUS = 6378137;
const firebaseConfig = {
    apiKey: "AIzaSyA777OVFMDEgGDyf5BbKSkwbweBLOputZ0",
    authDomain: "pidsvituai.firebaseapp.com",
    projectId: "pidsvituai",
    storageBucket: "pidsvituai.firebasestorage.app",
    messagingSenderId: "291103271838",
    appId: "1:291103271838:web:7df3b779433dc4c583c48f",
    measurementId: "G-8BR4E3W54K"
};
let savedAreaId = null;
let savedStreetName = null;
let savedStreetGeoJSON = null;
let map = null, darkLayer = null, lightLayer = null, mainLayer = null;
let crossingLayer = null, buildingLayer = null, lightsLayer = null;

function normalizeStreetName(name) {
    if (!name) {
        return "";
    }
    const cleanName = name
        .replace(/^(вул\.|вулиця|проспект|просп\.|площа|парк|пл\.|м-н)\s*/i, '')
        .replace(/\./g, '_')
        .trim();
    return cleanName;
}

function createFlexibleSearchPattern(searchName) {
    let cleaned = searchName
        .replace(/^(вул\.|вулиця|проспект|просп\.|площа|парк|пл\.|м-н)\s*/i, '')
        .trim();
    const words = cleaned.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return searchName;
    const flexiblePattern = words
        .map(word => {
            const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return escaped;
        })
        .join('.*');
    return flexiblePattern;
}

function matchesSearchQuery(name, searchQuery) {
    if (!name || !searchQuery) return false;
    const normalizedName = name.toLowerCase()
        .replace(/^(вул\.|вулиця|проспект|просп\.|площа|парк|пл\.|м-н)\s*/i, '')
        .trim();
    const normalizedSearch = searchQuery.toLowerCase()
        .replace(/^(вул\.|вулиця|проспект|просп\.|площа|парк|пл\.|м-н)\s*/i, '')
        .trim();
    if (normalizedName === normalizedSearch) return true;
    const searchWords = normalizedSearch.split(/\s+/);
    const allWordsPresent = searchWords.every(word => 
        normalizedName.includes(word)
    );
    if (allWordsPresent) return true;
    const expandedName = normalizedName
        .replace(/\bім\./gi, 'іменем')
        .replace(/\bпросп\./gi, 'проспект')
        .replace(/\bвул\./gi, 'вулиця');
    
    const expandedSearch = normalizedSearch
        .replace(/\bім\./gi, 'іменем')
        .replace(/\bпросп\./gi, 'проспект')
        .replace(/\bвул\./gi, 'вулиця');
    
    const expandedWords = expandedSearch.split(/\s+/);
    const allExpandedPresent = expandedWords.every(word => 
        expandedName.includes(word)
    );
    
    return allExpandedPresent;
}

function updateStatus(msg, type = 'normal') {
    const statusDiv = document.getElementById('status');
    statusDiv.className = ''; 
    
    if (type === 'error') {
        statusDiv.innerHTML = `⚠️ ${msg}`;
        statusDiv.classList.add('error-msg');
    } else if (type === 'success') {
        statusDiv.innerHTML = `✅ ${msg}`;
        statusDiv.classList.add('success-msg');
    } else {
        statusDiv.innerHTML = `${msg}`;
    }
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            const text = await response.text();
            if (text.trim().startsWith('<') && !text.includes('<osm')) {
                throw new Error("API overloaded");
            }
            return JSON.parse(text);
        } catch (err) {
            if (i === retries - 1) throw err;
            await wait(2500);
        }
    }
}

let proj4Available = false;

function initProj4() {
    if (typeof proj4 === 'undefined') {
        return false;
    }
    proj4.defs("EPSG:32634", "+proj=utm +zone=34 +datum=WGS84 +units=m +no_defs");
    proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");
    proj4Available = true;
    return true;
}

function utmToLatLng(easting, northing, zone = 34) {
    if (!proj4Available && !initProj4()) {
        return fallbackUtmToLatLng(easting, northing);
    }
    try {
        const [lng, lat] = proj4("EPSG:32634", "EPSG:4326", [easting, northing]);
        return { lat, lng };
    } catch (error) {
        return fallbackUtmToLatLng(easting, northing);
    }
}

function fallbackUtmToLatLng(easting, northing) {
    if (easting > 6000000 && northing > 2600000) {
        const refEasting = 6418400;
        const refNorthing = 2673800;
        const refLat = 49.8419;
        const refLng = 24.0315;
        const metersPerDegreeLat = 111000;
        const metersPerDegreeLng = 73000;
        const deltaEasting = easting - refEasting;
        const deltaNorthing = northing - refNorthing;
        const lat = refLat + (deltaNorthing / metersPerDegreeLat);
        const lng = refLng + (deltaEasting / metersPerDegreeLng);
        return { lat, lng };
    }
    if (easting > 400000 && easting < 500000) {
        const centerLat = 49.84;
        const centerLng = 24.03;
        const centerEasting = 448000;
        const centerNorthing = (northing > 5000000) ? 5525000 : northing;
        const deltaEasting = easting - centerEasting;
        const deltaNorthing = (northing > 5000000) ? (northing - centerNorthing) : northing;
        const lat = centerLat + (deltaNorthing / 111000);
        const lng = centerLng + (deltaEasting / (111000 * Math.cos(centerLat * Math.PI / 180)));
        return { lat, lng };
    }
    return { lat: 49.8419, lng: 24.0315 };
}

function isUTMCoordinate(x, y) {
    if (x > 400000 && x < 500000 && y > 5500000 && y < 5550000) {
        return true;
    }
    if (x > 400000 && x < 500000 && y > 2600000 && y < 2700000) {
        return true;
    }
    if (x > 6000000 && x < 7000000 && y > 2600000 && y < 2700000) {
        return true;
    }
    return false;
}

function showMap() {
    document.getElementById('welcomeScreen').classList.add('hidden');
    setTimeout(() => {
        document.getElementById('mapContainer').classList.add('active');
        document.getElementById('bottomPanel').classList.add('active');
        if (!map) initMap();
    }, 300);
}

function initMap() {
    map = L.map('map', { 
        maxBounds: LVIV_BOUNDS, 
        maxBoundsViscosity: 1.0 
    }).setView([49.8419, 24.0315], 13);
    
    darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { 
        attribution: '&copy; OSM contributors' 
    });
    
    lightLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { 
        attribution: '&copy; OSM contributors' 
    });
    
    darkLayer.addTo(map);
    mainLayer = L.layerGroup().addTo(map);
    crossingLayer = L.layerGroup().addTo(map);
    buildingLayer = L.layerGroup().addTo(map);
    lightsLayer = L.layerGroup().addTo(map);
}

function resetMap() {
    if (mainLayer) mainLayer.clearLayers();
    if (buildingLayer) buildingLayer.clearLayers();
    if (crossingLayer) crossingLayer.clearLayers();
    if (lightsLayer) lightsLayer.clearLayers();
    
    savedStreetGeoJSON = null; 
    savedStreetName = null;

    document.getElementById('recommendations').style.display = 'none';
    document.getElementById('crossingsBtn').style.display = 'none';
    document.getElementById('suggestionsList').style.display = 'none'; 
    document.getElementById('mapContainer').classList.remove('active');
    document.getElementById('bottomPanel').classList.remove('active');
    document.getElementById('streetNamePart').value = '';
    
    setTimeout(() => { 
        document.getElementById('welcomeScreen').classList.remove('hidden'); 
    }, 300);
}

function quickSearch(type, name) {
    const select = document.getElementById('streetPrefix');
    select.value = type;
    const input = document.getElementById('streetNamePart');
    input.value = name;
    analyzeStreet();
}

async function analyzeStreet() {
    const city = document.getElementById('cityInput').value;
    const namePart = document.getElementById('streetNamePart').value.trim();
    const btn = document.getElementById('analyzeBtn');

    const typeEl = document.getElementById('streetPrefix');
    const isParkSearch = (typeEl && typeEl.value === 'Парк') || 
                          namePart.toLowerCase().includes('парк');
    
    if(!city || !namePart || namePart.length < 3) { 
        alert("Перевірте введені дані"); 
        return; 
    }
    
    btn.disabled = true;
    showMap();
    await wait(400);
    
    updateStatus(`Шукаю ${isParkSearch ? "парк" : "вулицю"} "${namePart}"...`);

    try {
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?city=${city}&format=json&limit=1`;
        const cityRes = await fetch(nominatimUrl);
        const cityData = await cityRes.json();
        
        if (cityData.length === 0) {
            throw new Error("Місто не знайдено");
        }
        
        savedAreaId = 3600000000 + parseInt(cityData[0].osm_id);
        let query = '';
        const searchPattern = createFlexibleSearchPattern(namePart);
        if (isParkSearch) {
            query = `
                [out:json][timeout:180][maxsize:20000000];
                area(${savedAreaId})->.searchArea;
                (
                  way["name"~"${searchPattern}", i]["leisure"="park"](area.searchArea);
                  relation["name"~"${searchPattern}", i]["leisure"="park"](area.searchArea);
                  way["name"~"парк.*${searchPattern}", i]["leisure"="park"](area.searchArea);
                  relation["name"~"парк.*${searchPattern}", i]["leisure"="park"](area.searchArea);
                )->.parkGeom;
                .parkGeom map_to_area -> .parkArea;
                
                (
                  way["highway"~"footway|path|pedestrian|cycleway|steps"](area.parkArea);
                )->.paths;

                (
                  node["leisure"="playground"](area.parkArea);
                  way["leisure"="playground"](area.parkArea);
                )->.playgrounds;

                .parkGeom out geom;
                .paths out geom;
                .playgrounds out geom;
            `;
        } else {
            query = `
                [out:json][timeout:180][maxsize:20000000];
                area(${savedAreaId})->.searchArea;
                (
                  way["name"~"${searchPattern}", i]["highway"](area.searchArea);
                  way["name"~"вулиця.*${searchPattern}", i]["highway"](area.searchArea);
                  way["name"~"проспект.*${searchPattern}", i]["highway"](area.searchArea);
                )->.street;
                (way["highway"~"footway|path|pedestrian|sidewalk"](around.street:${MAX_SEARCH_DIST + 20});)->.sidewalks;
                (way["building"](around.street:30);)->.buildings;
                .street out geom; .sidewalks out geom; .buildings out geom;
            `;
        }

        const data = await fetchWithRetry(
            'https://overpass-api.de/api/interpreter', 
            { method: 'POST', body: "data=" + encodeURIComponent(query) }
        );
        
        if (!data.elements || data.elements.length === 0) {
            throw new Error(
                isParkSearch ? "Парк або доріжки не знайдено." : "Вулиця не знайдена."
            );
        }
        
        updateStatus("Візуалізація геометрії...");
        if (isParkSearch) {
            await processParkVisualization(data, namePart);
        } else {
            await processStreetVisualization(data, namePart);
        }
        if (savedStreetName) {
            await loadLightingData(savedStreetName);
        } else {
            updateStatus("Об'єкт знайдено, але назва не визначена", 'error');
        }
    } catch (error) {
        updateStatus(`Помилка: ${error.message}`, 'error');
    } finally { 
        btn.disabled = false; 
    }
}

async function processParkVisualization(data, searchName) {
    const pathFeatures = [];
    const parkFeatures = [];
    const playgroundFeatures = [];
    let foundParkName = searchName;
    let bestMatchScore = 0;

    data.elements.forEach(el => {
        const tags = el.tags || {};
        const elementName = tags.name || '';
        const isMatch = matchesSearchQuery(elementName, searchName);
        
        if (el.type === 'node' && tags.leisure === 'playground') {
            playgroundFeatures.push(turf.point([el.lon, el.lat], tags));
        }

        if (el.type === 'way' && el.geometry) {
            const coords = el.geometry.map(p => [p.lon, p.lat]);
            
            if (tags.leisure === 'playground') {
                if (coords.length > 2) {
                      coords.push(coords[0]);
                      playgroundFeatures.push(turf.polygon([coords], tags));
                }
            }
            else if (tags.leisure === 'park') {
                if (coords.length > 2) {
                      coords.push(coords[0]); 
                      parkFeatures.push(turf.polygon([coords], tags));
                }
                if (isMatch && elementName) {
                    const score = elementName.length;
                    if (score > bestMatchScore) {
                        bestMatchScore = score;
                        foundParkName = elementName;
                    }
                }
            } 
            else if (tags.highway && parkFeatures.length > 0) {
                pathFeatures.push(turf.lineString(coords, tags));
            }
        }
    });

    if (pathFeatures.length === 0 && parkFeatures.length === 0) { 
        alert("Дані парку неповні."); 
        return;
    }
    savedStreetName = foundParkName;
    savedStreetGeoJSON = turf.featureCollection(pathFeatures);

    if(parkFeatures.length > 0) {
        L.geoJSON(turf.featureCollection(parkFeatures), { 
            style: { color: '#2ecc71', weight: 2, fillOpacity: 0.05, dashArray: '5, 5' } 
        }).addTo(mainLayer);
    }

    if(playgroundFeatures.length > 0) {
        L.geoJSON(turf.featureCollection(playgroundFeatures), {
            pointToLayer: function (feature, latlng) {
                return L.circleMarker(latlng, {
                    radius: 8,
                    fillColor: "#03d3fc",
                    color: "#03d3fc",
                    weight: 1,
                    opacity: 1,
                    fillOpacity: 0.8
                });
            },
            style: { 
                color: '#03d3fc', 
                weight: 2, 
                fillColor: '#03d3fc', 
                fillOpacity: 0.5 
            },
            onEachFeature: function(feature, layer) {
                layer.bindPopup(`<div class="info-popup-row">⚽ <b>Дитячий майданчик</b></div>`);
            }
        }).addTo(mainLayer);
    }

    if (pathFeatures.length > 0) {
        L.geoJSON(savedStreetGeoJSON, {
            style: { color: '#f1c40f', weight: 3, opacity: 0.8 },
            onEachFeature: function(feature, layer) {
                layer.bindPopup(`<div class="info-popup-row"><span class="info-popup-label">Доріжка парку</span></div>`);
            }
        }).addTo(mainLayer);
    }

    const allFeatures = [...parkFeatures, ...pathFeatures, ...playgroundFeatures];
    if (allFeatures.length > 0) {
        const bbox = turf.bbox(turf.featureCollection(allFeatures));
        map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]]);
    }
}

async function processStreetVisualization(data, searchName) {
    const streetFeatures = [];
    const sidewalkFeatures = [];
    const buildingFeatures = [];
    let foundFullName = null;
    let bestMatchScore = 0;

    data.elements.forEach(el => {
        if (el.type === 'way' && el.geometry) {
            const coords = el.geometry.map(p => [p.lon, p.lat]);
            
            if (el.tags && el.tags.building) {
                if (coords.length > 2) { 
                    coords.push(coords[0]); 
                    buildingFeatures.push(turf.polygon([coords], el.tags)); 
                }
                return;
            }
            
            const line = turf.lineString(coords, el.tags);
            const tags = el.tags || {};
            const elName = tags.name || "";
            const isMatch = matchesSearchQuery(elName, searchName);
            const isStreet = isMatch && 
                           tags.highway && 
                           !tags.highway.match(/footway|path|pedestrian|cycleway/);
            
            if (isStreet) {
                streetFeatures.push(line);
                if (elName.length > bestMatchScore) {
                    bestMatchScore = elName.length;
                    foundFullName = elName;
                }
            } else if (tags.highway) { 
                sidewalkFeatures.push(line); 
            }
        }
    });

    if (streetFeatures.length === 0) { 
        alert("Вулиця не знайдена."); 
        return; 
    }
    savedStreetName = foundFullName;
    savedStreetGeoJSON = turf.featureCollection(streetFeatures);

    L.geoJSON(savedStreetGeoJSON, { 
        style: { color: '#3498db', weight: 5, opacity: 0.6 },
        onEachFeature: function(feature, layer) {
            let p = feature.properties;
            layer.bindPopup(`
                <div class="info-popup-row">
                    <span class="info-popup-label">Вулиця:</span>
                    <b>${p.name || savedStreetName}</b>
                </div>
            `);
        }
    }).addTo(mainLayer);
    if(buildingFeatures.length > 0) {
        L.geoJSON(turf.featureCollection(buildingFeatures), { 
            style: function(feature) {
                if (feature.properties && feature.properties.name) {
                    return { 
                        color: '#D20A2E',
                        weight: 2, 
                        fillColor: '#D20A2E',
                        fillOpacity: 0.3
                    };
                }
                return { 
                    color: '#555', 
                    weight: 1, 
                    fillOpacity: 0.1 
                };
            },
            onEachFeature: function(feature, layer) {
                if (feature.properties && feature.properties.name) {
                    layer.bindPopup(`<b>Високий потенціал появи архітектурної підсвітки</b>`);
                }
            }
        }).addTo(buildingLayer);
    }
    const bbox = turf.bbox(savedStreetGeoJSON);
    map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]]);
    
    document.getElementById('crossingsBtn').style.display = 'block';
}

async function loadLightingData(streetName) {
    if (!map) {
        return;
    }
    if (!streetName) {
        return;
    }
    try {
        updateStatus("Пошук у базі даних Firebase...");
        const lightsData = await loadFromFirebase(streetName);
        if (lightsData && lightsData.length > 0) {
            visualizeLights(lightsData);
            updateStatus(`Завантажено ${lightsData.length} світильників з бази`, 'success');
            setTimeout(() => {
                const layerCount = Object.keys(lightsLayer._layers).length;
                if (layerCount === 0) {
                    updateStatus("Помилка візуалізації. Спробуйте ще раз.", 'error');
                }
            }, 500);
            return;
        }
    } catch (fbError) {
    }
    updateStatus("Не вдалося отримати дані про освітлення", 'error');
}

async function loadFromFirebase(streetName) {
    if (!db) {
        throw new Error("Firebase не підключено");
    }
    
    if (!streetName) {
        throw new Error("Назва вулиці/парку не передана");
    }

    try {
        const typeEl = document.getElementById('streetPrefix');
        const isParkSearch = (typeEl && typeEl.value === 'Парк') || 
                             streetName.toLowerCase().includes('парк');
        const normalizedName = normalizeStreetName(streetName);
        const variants = [
            streetName,
            normalizedName,
            normalizedName.replace(/_/g, '.'),
            normalizedName.replace(/ім_/gi, 'іменем '),
            streetName.replace(/\./g, '_'),
        ];
        if (isParkSearch) {
            variants.push(
                `Парк ${normalizedName}`,
                `парк ${normalizedName}`,
                `Парк ${normalizedName.replace(/_/g, '.')}`,
            );
        }
        const primaryCollection = isParkSearch ? 'park' : 'streets';
        for (const variant of variants) {
            const docRef = db.collection(primaryCollection).doc(variant);
            const doc = await docRef.get();
            if (doc.exists) {
                const data = doc.data();
                const lightsCSV = data.lights;
                if (lightsCSV) {
                    return parseCSVLights(lightsCSV);
                }
            }
        }
        const secondaryCollection = isParkSearch ? 'streets' : 'park';
        for (const variant of variants) {
            const docRef = db.collection(secondaryCollection).doc(variant);
            const doc = await docRef.get();
            if (doc.exists) {
                const data = doc.data();
                const lightsCSV = data.lights;
                if (lightsCSV) {
                    return parseCSVLights(lightsCSV);
                }
            }
        }
        return null;
    } catch (error) {
        throw error;
    }
}

async function saveToFirebase(streetName, lightsData) {
    if (!db) {
        return;
    }
    try {
        const typeEl = document.getElementById('streetPrefix');
        const isPark = (typeEl && typeEl.value === 'Парк') || 
                       streetName.toLowerCase().includes('парк');
        let normalizedName = streetName
            .replace(/^(вул\.|вулиця|проспект|просп\.|площа|парк|пл\.|м-н)\s*/i, '')
            .replace(/\./g, '_')
            .trim();
        if (isPark && !normalizedName.toLowerCase().startsWith('парк')) {
            normalizedName = `Парк ${normalizedName}`;
        }
        const lightsCSV = lightsData.map(light => 
            `${light.lat},${light.lng},${light.height},${light.type},${light.colorTemp}`
        ).join('\n');
        const collection = isPark ? 'park' : 'streets';
        const docRef = db.collection(collection).doc(normalizedName);
        await docRef.set({
            name: streetName,
            normalized_name: normalizedName,
            lights: lightsCSV,
            light_count: lightsData.length,
            created_at: firebase.firestore.FieldValue.serverTimestamp(),
            source: 'api'
        });
    } catch (error) {
    }
}

function parseCSVLights(csvString) {
    const lights = [];
    
    let entries = csvString.trim().split('\n');
    
    if (entries.length === 1) {
        entries = csvString.trim().split(/\s+/);
    }
    
    entries.forEach((entry, index) => {
        const parts = entry.trim().split(',');
        
        if (parts.length >= 2) {
            let x = parseFloat(parts[0]);
            let y = parseFloat(parts[1]);
            
            if (isNaN(x) || isNaN(y)) {
                return;
            }
            let lat, lng;
            if (isUTMCoordinate(x, y)) {
                const converted = utmToLatLng(x, y, UTM_ZONE);
                lat = converted.lat;
                lng = converted.lng;
            } else {
                lat = x;
                lng = y;
            }
            lights.push({
                lat: lat,
                lng: lng,
                height: parts[2] ? parseFloat(parts[2]) : 8.0,
                type: parts[3] || 'pole',
                colorTemp: parts[4] || '3000K'
            });
        }
    });
    return lights;
}

function visualizeLights(lightsData) {
    if (lightsLayer) {
        lightsLayer.clearLayers();
    } else {
        return;
    }
    if (!map) {
        return;
    }
    if (!lightsData || lightsData.length === 0) {
        return;
    }
    let addedCount = 0;
    lightsData.forEach((light, index) => {
        const { lat, lng, height, type, colorTemp } = light;
        if (isNaN(lat) || isNaN(lng)) {
            return;
        }
        const color = colorTemp.includes('4000') ? '#eefaff' : '#ffb74d';
        const radius = height * 1.7;
        try {
            L.circle([lat, lng], {
                radius: radius * 0.6,
                color: 'transparent',
                fillColor: color,
                fillOpacity: 0.3,
                interactive: false
            }).addTo(lightsLayer);
            L.circle([lat, lng], {
                radius: radius,
                color: 'transparent',
                fillColor: color,
                fillOpacity: 0.15,
                interactive: false
            }).addTo(lightsLayer);
            const marker = L.circleMarker([lat, lng], {
                radius: 4,
                color: '#333',
                weight: 1,
                fillColor: '#fff',
                fillOpacity: 1,
                interactive: true
            });
            
            const typeName = type === 'suspended' ? 'Підвісний' : 'Опора';
            
            marker.bindPopup(`
                <div class="info-popup-row">
                    <span class="info-popup-label">Тип:</span><b>${typeName}</b>
                </div>
                <div class="info-popup-row">
                    <span class="info-popup-label">Температура:</span>${colorTemp}
                </div>
                <div class="info-popup-row">
                    <span class="info-popup-label">Висота:</span>~${height.toFixed(1)} м
                </div>
                <div class="info-popup-row" style="font-size: 0.85em; color: #999;">
                    ID: ${index + 1}
                </div>
            `);
            
            marker.addTo(lightsLayer);
            addedCount++;
        } catch (error) {
        }
    });
    if (map) {
        setTimeout(() => {
            map.invalidateSize();
        }, 100);
    }
    if (!map.hasLayer(lightsLayer)) {
        lightsLayer.addTo(map);
    }
}

async function findCrossings() {
    if (!savedAreaId || !savedStreetName) return;
    
    updateStatus(`Шукаю переходи для ${savedStreetName}...`);
    
    const query = `
        [out:json][timeout:60];
        area(${savedAreaId})->.searchArea;
        way["name"="${savedStreetName}"]["highway"](area.searchArea)->.street;
        node["highway"="crossing"](around.street:2);
        out geom;
    `;
    
    try {
        const data = await fetchWithRetry(
            'https://overpass-api.de/api/interpreter', 
            {method: 'POST', body: "data=" + encodeURIComponent(query)}
        );
        
        if (!data.elements) {
            return updateStatus("Переходи не знайдено");
        }
        
        const streetLines = savedStreetGeoJSON.features; 
        let count = 0;
        
        data.elements.forEach(el => {
            if (el.type === 'node') {
                const p = turf.point([el.lon, el.lat]);
                let minD = Infinity;
                
                streetLines.forEach(l => { 
                    const d = turf.pointToLineDistance(p, l, {units: 'meters'}); 
                    if(d < minD) minD = d; 
                });
                
                if(minD <= 2) {
                    const mk = L.marker([el.lat, el.lon], {
                        icon: L.divIcon({
                            className: 'crossing-icon', 
                            html: '🟢', 
                            iconSize: [20, 20]
                        })
                    });
                    mk.bindPopup("<b>Пішохідний перехід</b>");
                    mk.addTo(crossingLayer);
                    count++;
                }
            }
        });
        
        updateStatus(`Знайдено переходів: ${count}`, 'success');
    } catch (error) {
        updateStatus("Помилка пошуку переходів", 'error');
    }
}

const streetInput = document.getElementById('streetNamePart');
const suggestionsList = document.getElementById('suggestionsList');
let debounceTimer;

streetInput.addEventListener('input', function() {
    const query = this.value.trim();
    const city = document.getElementById('cityInput').value || 'Львів'; 
    clearTimeout(debounceTimer);
    suggestionsList.style.display = 'none';

    if (query.length < 3) return;

    debounceTimer = setTimeout(async () => {
        try {
            const url = `https://nominatim.openstreetmap.org/search?street=${encodeURIComponent(query)}&city=${encodeURIComponent(city)}&format=json&limit=5&dedupe=1`;
            const response = await fetch(url);
            const data = await response.json();
            
            const uniqueStreets = [...new Set(
                data.map(item => item.name).filter(name => name)
            )];
            
            renderSuggestions(uniqueStreets);
        } catch (error) {
        }
    }, 250);
});

function renderSuggestions(streets) {
    suggestionsList.innerHTML = '';
    
    if (streets.length === 0) {
        suggestionsList.style.display = 'none';
        return;
    }
    
    streets.forEach(streetName => {
        const li = document.createElement('li');
        li.textContent = streetName;
        li.addEventListener('click', () => {
            streetInput.value = streetName;
            suggestionsList.style.display = 'none';
        });
        suggestionsList.appendChild(li);
    });
    
    suggestionsList.style.display = 'block';
}

document.addEventListener('click', (e) => {
    if (!streetInput.contains(e.target) && !suggestionsList.contains(e.target)) {
        suggestionsList.style.display = 'none';
    }
});

document.getElementById('streetNamePart').addEventListener('keypress', function(e) { 
    if (e.key === 'Enter') analyzeStreet(); 
});

async function forceVisualizeLightsFromFirebase() {
    if (!savedStreetName) {
        alert("Спочатку виберіть вулицю або парк!");
        return;
    }
    
    if (!map || !lightsLayer) {
        alert("Карта не ініціалізована!");
        return;
    }
    updateStatus("Завантаження світильників з Firebase...");
    try {
        const lightsData = await loadFromFirebase(savedStreetName);
        if (!lightsData || lightsData.length === 0) {
            updateStatus("Світильники не знайдено в Firebase", 'error');
            return;
        }
        lightsLayer.clearLayers();
        visualizeLights(lightsData);
        updateStatus(`Візуалізовано ${lightsData.length} світильників`, 'success');
        setTimeout(() => {
            const layerCount = Object.keys(lightsLayer._layers).length;
            if (layerCount === 0) {
                alert("❌ ПОМИЛКА: Світильники не відобразились!\nДив. консоль браузера (F12)");
            }
        }, 1000);
    } catch (error) {
        updateStatus(`Помилка: ${error.message}`, 'error');
        alert(`Помилка завантаження:\n${error.message}`);
    }
}

if (typeof proj4 !== 'undefined') {
    initProj4();
}


