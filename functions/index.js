const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { defineString } = require('firebase-functions/params');
const axios = require('axios'); // Para chamadas HTTP
const OpenAI = require('openai');

const admin = require('firebase-admin');
admin.initializeApp();

const OPENAI_API_KEY = defineString('OPENAI_API_KEY');
const TWILIO_ACCOUNT_SID = defineString('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineString('TWILIO_AUTH_TOKEN');
const TWILIO_STUDIO_FLOW_SID = defineString('TWILIO_STUDIO_FLOW_SID');
const TWILIO_MESSAGE_SERVICE_SID = defineString('TWILIO_MESSAGE_SERVICE_SID');


const openai = new OpenAI({ apiKey: OPENAI_API_KEY.value() });



const activateStudio = async (to, json) => {
    const client = require('twilio')(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());

    logger.info(`activateStudio: executando via ${TWILIO_MESSAGE_SERVICE_SID.value()}`);

    client.studio.v2.flows(TWILIO_STUDIO_FLOW_SID.value())
    .executions
    .create({
        to, 
        from: TWILIO_MESSAGE_SERVICE_SID.value(),
        parameters: {
            json
        }
    })
    .then(execution => console.log(execution.sid));

}
// Defina suas variáveis de ambiente no Firebase.

exports.identificaLixo = onRequest(async (request, response) => {
    logger.info("Processando requisição", {structuredData: true});
    logger.info('Conteúdo da requisição', request.body);

    const imageUrl = request.body.url; // A URL da imagem enviada via Twilio.
    
    if (!imageUrl) {
        logger.error('Nenhuma URL de imagem fornecida');
        response.status(400).send('Nenhuma URL de imagem fornecida');
        return;
    }

    try {
        // Simulação de análise de imagem pela OpenAI. Substitua isso pela sua implementação real.
        const aiResponse = await analyzeImageWithOpenAI(imageUrl, request.body.from);
        activateStudio(request.body.to, aiResponse);
        response.status(200).send(JSON.stringify(aiResponse));
    } catch (error) {
        logger.error('Erro ao processar a imagem', error);
        response.status(500).send('Erro interno');
    }
});


exports.importaPontosColeta = onRequest(async (request, response) => {
    logger.info('CHAMOU importaPontosColeta!');

    // Ler o arquivo JSON com os dados a serem importados
    const dados = require('./data/pontosColeta.json');
    const promises = [];
    
    dados.forEach(ponto => {
        const promise = admin.firestore().collection('pontosColeta').add(ponto);
        promises.push(promise);
    });

    try {
        await Promise.all(promises);
        response.status(200).send("Dados importados com sucesso para a coleção pontosColeta.");
    } catch (error) {
        console.error("Erro ao importar dados: ", error);
        response.status(500).send("Erro ao importar dados para a coleção pontosColeta.");
    }
});


exports.listaEcopontos = onRequest(async (request, response) => {

    // TODO: parametro de filtro "request.body.filtro"
    // TODO: caso venha sem parâmetro filtar os que tem 

    const geofire = require('geofire-common');
    let center = [];
    let radiusInM = 5 * 1000; 

    if (request.body.lat && request.body.lng) {
        center = [ parseFloat(request.body.lat), parseFloat(request.body.lng) ];
        logger.info('listaEcopontos', center);
    } else {
        // TODO: fazer geolocation do texto
    }

    let tipos = null;
    if (request.body.filtro) {
        tipos = request.body.filtro.toLowerCase().split(', ');
        // if (tipos.includes('Entulhos')) {
        //     radiusInM = 10 * 1000; 
        // }
    }


    const bounds = geofire.geohashQueryBounds(center, radiusInM);
    logger.info('BOUNDS', bounds);

    const promises = [];
    for (const b of bounds) {
        const q = admin.firestore()
            .collection('pontosColeta')
            .orderBy('geohash')
            .startAt(b[0]).endAt(b[1]);

        promises.push(q.get());
    }
    
    // Collect all the query results together into a single list
    const snapshots = await Promise.all(promises);
    
    const matchingDocs = [];
    for (const snap of snapshots) {
      for (const doc of snap.docs) {
        const lat = parseFloat(doc.get('latitude'));
        const lng = parseFloat(doc.get('longitude'));
    
        // We have to filter out a few false positives due to GeoHash
        // accuracy, but most will match
        const distanceInKm = geofire.distanceBetween([lat, lng], center);
        const distanceInM = distanceInKm * 1000;

        // logger.info('distanceInKm', distanceInKm);
        if (distanceInM <= radiusInM) {
            let data = doc.data();
            data.distanceInM = distanceInM;
            data.distanceInKm = distanceInKm;
            matchingDocs.push(data);
        }
      }
    }

    // TODO: fazer sort por distanceInM
    let ecopontos = matchingDocs;

    ecopontos = ecopontos.sort((current, next) => current.distanceInM - next.distanceInM);
    logger.info('ECOPONTOS GERAL SORTED', ecopontos);

    if (tipos) {
        // const tipos = request.body.filtro.toLowerCase().split(', ');
        logger.info('TIPOS ENCONTRADOS', tipos);

        // Filtrar locais
        ecopontos = ecopontos.filter(function(e) {
            return e.itens_recebidos.some(function(item) {
                return tipos.includes(item);
            });
        });
    } else {
        // categoria padrão precisa listar pelo menos 3 tipos de itens recebidos
        ecopontos = ecopontos.filter( e => e.itens_recebidos.length >= 3 );
        logger.info('ECOPONTOS 3 TIPOS', ecopontos);

    }


    if (ecopontos.length > 0) {
        const ecoponto = ecopontos[0]
        // TODO: receber lat long ou endereço
        logger.info('RESULTADO GEOHASH', ecopontos);

        response.contentType('application/json').status(200).send(JSON.stringify({
            mensagem: `Encontrei o seguinte ecoponto próximo de você:\n\n*${ecoponto.nome}*\n\n${ecoponto.endereco}\nCep: ${ecoponto.cep}\n\n*${ecoponto.distanceInM.toFixed(0)} metro(s) de você.*\n\nTelefone: ${ecoponto.telefone}\nHorário de Funcionamento: ${ecoponto.horario_funcionamento}.\n\nItens aceitos: ${ecoponto.itens_recebidos.join(', ')}`,
            location: {
                lat: ecoponto.latitude,
                lng: ecoponto.longitude
            },
            nome: ecoponto.nome
        }));

    } else {
        // TODO: receber lat long ou endereço
        logger.info('RESULTADO GEOHASH: SEM ECOPONTO');

        response.contentType('application/json').status(200).send(JSON.stringify({
            mensagem: `Não encontrei nenhum ecoponto em um raio de 5 quilômetros da sua localização.`
        }));
        // response.status(200).send(`Não encontrei nenhum ecoponto em um raio de 5 quilômetros da sua localização.`);

    }

    
});

exports.gerarDicaRandomica = onRequest(async (request, response) => {
    const dicas = [
        { 
            mensagem: `*Compre a granel:* Comprar a granel pode ajudar a reduzir a quantidade de embalagens individuais que você consome. Procure lojas que oferecem opções a granel para itens como alimentos, produtos de limpeza e itens de higiene pessoal.`,
            imagem: ``
        },
        { 
            mensagem: `*Recicle corretamente:* Certifique-se de separar seus resíduos em materiais recicláveis e não-recicláveis e lembre de manter os recicláveis SECOS e LIMPOS para evitar contaminação. Se tiver dúvida sobre um item, mande a foto aqui 😉`,
            imagem: ``
        },
        { 
            mensagem: `*Escolha produtos com menos embalagens:* Ao comprar produtos, prefira aqueles que possuem menos embalagens ou que vêm em embalagens recicláveis. Evite produtos excessivamente embalados em plástico ou outros materiais não-recicláveis.`,
            imagem: ``
        },
        { 
            mensagem: `*Símbolo de FSC (Forest Stewardship Council):* Se você estiver procurando por produtos de papel ou madeira, pode procurar por produtos certificados pelo FSC. Este rótulo indica que o produto foi produzido de forma sustentável, considerando os aspectos ambientais, sociais e econômicos da sua produção.`,
            imagem: ``
        },
        { 
            mensagem: `*📷 Descarte seus móveis 🛏️ 🛋️ 🪑danificados em um ECOPONTO:* A cidade de São Paulo conta com Ecopontos especializados em dar o destino correto para seus móveis. Se puder, dirija-se até um local próximo e evite que esse material vá parar em um aterro, onde ficará por centenas de anos. Mande a foto do seu móvel aqui e compartilhe sua localização para que o Reciclar.ia te indique o ecoponto mais próximo😉`,
            imagem: ``
        }

    ]
    let dica = dicas[Math.floor(Math.random() * dicas.length)];
    response.contentType('application/json').status(200).send(JSON.stringify(dica));
});



const getFirestorePrompt = async () => {    
    const settings = await admin.firestore().collection('settings').doc('default').get();
    if (settings.exists) {
        settingsData = await settings.data();
        logger.info('EXISTE', settingsData.promptImagem);
        return settingsData.promptImagem;
    }
    return `Esta é a imagem de um lixo, faça uma análise completa e retorne um arquivo json seguinte formato:
            
    {
        "objeto" : <nome do objeto>,
        "material": <composição aproximada do material>,
        "emoji_material" : <emoji que melhor representa o material>,
        "tipo_de_descarte" : <"reciclavel", "lixo eletrônico", "compostagem", "descarte simples">,
        "condicao_descarte" : <avisos sobre cuidados específicos para que o material possa ser descartado adequadamente">,
        "reuso": <"sim", "não", "talvez">,
        "possibilidades_criativas_de_reuso" : <uma ideia interessante para uso criativo e artistico>
        "justificativa_talvez" :  <explique porque você esta em dúvida>
    }

    Retorne APENAS o conteúdo do JSON de forma textual e nada mais. Deve ser um JSON válido.
    `;
}

async function analyzeImageWithOpenAI(imageUrl,from) {
    const openAIResponse = await openai.chat.completions.create({
      model: "gpt-4-vision-preview",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: await getFirestorePrompt() },
            {
              type: "image_url",
              image_url: {
                "url": imageUrl,
              },
            },
          ],
        },
      ],
    });
    logger.info('OPENAI Response', openAIResponse)
    let response = openAIResponse.choices[0].message.content.split('```json').join('').split('```').join('')
    // Assumindo que a resposta da OpenAI vem no formato esperado, você pode precisar fazer um parse adicional
    // dependendo de como a informação é formatada na resposta.
    console.log(response);
    try {
        response = JSON.parse(response)
        await admin.firestore().collection('logs').add({
            timestamp: admin.firestore.Timestamp.now(),
            messageResponse: openAIResponse.choices[0].message,
            response: response,
            from,
            imageUrl
        });
      
        // Aqui você retornaria a resposta processada conforme necessário para seu uso.
        // Isso pode envolver converter a string JSON em um objeto JavaScript para facilitar o manuseio.
        
  }
    catch (error)
    {
      response = { "mensagem" : openAIResponse.choices[0].message.content}
      await admin.firestore().collection('logs').add({
      
        messageResponse: openAIResponse.choices[0].message,
        from,
        imageUrl
        });

    }

    return response;
}


exports.fetchHorarioColeta = onRequest({
    timeoutSeconds: 10,
}, async (request, response) => {
    // Parâmetros para a requisição ao endpoint
    const { lat, lng, to } = request.body;
    const dst = '50'; // Distância padrão
    const limit = '5'; // Limite padrão de resultados

    const ecourbis_url = `https://apicoleta.ecourbis.com.br/coleta?lat=${lat}&lng=${lng}&dst=${dst}&limit=${limit}`;
    // const ecourbis_url = `https://apicoleta.ecourbis.com.br/coleta?lat=-23.6193175&lng=-46.682458&dst=100`;
    const loga_url = `https://webservices.loga.com.br/sgo/eresiduos/BuscaPorLatLng?distance=${dst}&lat=${lat}&lng=${lng}`
    const header = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3'
    }

    let found = false;
    let msg = `Infelizmente, a sua região não foi encontrada nos pontos de coleta seletiva da LOGA. Caso sua localidade seja atendida pela a ECOURBIS não é possível fazer a consulta neste momento. :(`

    // try {
        // Verifica se há resultados na resposta ECOURBIS
        // logger.info('URL URBIS', ecourbis_url);
        // let { data } = await axios.get(ecourbis_url, { headers: header });

        // logger.info('API ECOURBIS Response', { data });
        // if (data && data.result && data.result.length > 0) {
        //     logger.info('RECEBEU DATA URBIS');
        //     found = true;    
        //     msg = await parseHorarioResponseEcourbis(data.result[0]);
        // } else {
        //     logger.info('SEM DATA URBIS');
        // }

        // Verifica se há resultados na resposta LOGA
        if (!found) {
            logger.info('URL LOGA', loga_url);
            let { data } = await axios.get(loga_url, { headers: header });
            logger.info('API Loga Response', { data });
            if (data && data.result) {
                console.log('Loga encontado!')
                found = true;
                if (data.found) {
                    msg = await parseHorarioResponseLoga(data.result.Logradouros);
                }
            }
        }
    // } catch (error) {
    //     logger.error("Erro na API Loga", { error });
    //     if (to) {
    //         activateStudio(to, { "mensagem" : "Infelizmente tivemos um erro. Tente mais tarde." });
    //     }
    // }

    
    if (to) {
        activateStudio(to, { "mensagem" : msg });
    }
    
    response.status(200).send(msg);

});

async function parseHorarioResponseEcourbis(coletaDataResponse) {
    logger.info('PARSE ECOURBIS', coletaDataResponse);
	const horariosDomiciliar = coletaDataResponse.domiciliar.horarios;
	const horariosSeletiva = coletaDataResponse.seletiva.horarios;

	// Construindo a string de resposta
	let resposta = 'Quem te atende é a Ecourbis!\nOs horários de coleta no seu local são:\nLixo comum:\n';
	Object.keys(horariosDomiciliar).forEach(dia => {
        resposta += `${dia}: ${horariosDomiciliar[dia]}\n`;
	});

	resposta += '\nColeta seletiva:\n';
	Object.keys(horariosSeletiva).forEach(dia => {
			if (horariosSeletiva[dia] !== '-') { // Inclui apenas os dias com horário definido
					resposta += `${dia}: ${horariosSeletiva[dia]}\n`;
			}
	});

	resposta += '\nAtenção: Os horários, quando informados, estão sujeitos à defasagem em virtude dos seguintes fatores: aumento de resíduos disponibilizados no setor, principalmente às segundas e terças-feiras, trânsito, desvios, interdição de vias, e/ou quaisquer outros alheios à operação.';
	return resposta;
}

async function parseHorarioResponseLoga(coletaData) {
    logger.info('PARSE LOGA', coletaData);

    let resposta = 'Quem te atende é a Loga!\nOs horários de coleta no seu local são:\nLixo comum:\n';
    // Coleta domiciliar
    if (coletaData[0]) {
        const domiciliar = coletaData[0].Domiciliar; //deve dar bool
        const dias = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom'];
        
        dias.forEach(dia => {
            console.log(`Has${dia}`)
            const hasDia = domiciliar[`Has${dia}`];
            
            if (hasDia) {
                const horario = domiciliar[`Hora${dia}`];
                resposta += `${dia}: ${horario}\n`;
            }
        });
    }

    resposta += '\nColeta seletiva:\n';
    // Coleta seletiva
    if (coletaData[0].Seletiva) {
        const seletiva = coletaData[0].Seletiva;
        const dias = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom'];

        dias.forEach(dia => {
            const hasDia = seletiva[`Has${dia}`];
            if (hasDia) {
                const horario = seletiva[`Hora${dia}`];
                resposta += `${dia}: ${horario}\n`;
            }
        });
    }

    resposta += '\nAtenção: Os horários, quando informados, estão sujeitos à defasagem em virtude dos seguintes fatores: aumento de resíduos disponibilizados no setor, principalmente às segundas e terças-feiras, trânsito, desvios, interdição de vias, e/ou quaisquer outros alheios à operação.';
    return resposta;
}
