const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const devotionalsData = [
  {
    date: '2026-08-30',
    title: 'O Bom Pastor Cuida de Você',
    source_name: 'Salmos 23:1-3',
    central_text: 'O Senhor é o meu pastor; de nada terei falta. Em verdes pastagens me faz repousar e me conduz a águas tranquilas; restaura-me as forças.',
    context_text: 'Davi conhecia a rotina de um pastor de ovelhas. Ele sabia que a ovelha não tem capacidade de se defender sozinha, nem de encontrar pastos verdejantes em terras áridas sem um guia. Quando declaramos que o Senhor é o nosso Pastor, reconhecemos que a nossa suficiência não vem da nossa própria força, mas do Seu cuidado incessante.\n\nNas tempestades e nos desertos da vida, Ele não apenas nos alimenta, mas restaura a nossa alma e nos dá paz em meio ao caos.',
    prayer_indication: 'Senhor, entrego todas as minhas ansiedades e necessidades em Tuas mãos. Reconheço que Tu és o meu Bom Pastor e que nada me faltará. Conduz os meus passos neste dia e renova as minhas forças. Em nome de Jesus, Amém.',
    suggested_song: 'Bondade de Deus - Isaías Saad',
    pastoral_comment: 'Descanse hoje na certeza de que Deus já preparou pastos verdejantes para o seu futuro.'
  },
  {
    date: '2026-08-31',
    title: 'Renovação e Força no Cansaço',
    source_name: 'Isaías 40:29-31',
    central_text: 'Ele fortalece o cansado e multiplica as forças ao que não tem nenhum vigor. Mas aqueles que esperam no Senhor renovam as suas forças. Voam alto como águias; correm e não ficam exaustos, andam e não se cansam.',
    context_text: 'Há momentos em que o cansaço não é apenas físico, mas emocional e espiritual. O profeta Isaías nos lembra que o Deus Eterno não se cansa nem se fatiga. Quando atingimos o nosso limite humano, é o momento em que a graça e o poder sobrenatural de Deus se manifestam.\n\nEsperar no Senhor não é passividade, mas uma atitude de confiança ativa de que Ele está agindo nos bastidores.',
    prayer_indication: 'Pai amado, quando as minhas forças se esgotarem, que a Tua graça me sustente. Ensina-me a esperar em Ti com paciência e fé. Renova o meu vigor para continuar a jornada. Amém.',
    suggested_song: 'Águia - Bruna Karla',
    pastoral_comment: 'Não desista no meio do caminho; as suas asas espirituais estão sendo fortalecidas hoje.'
  },
  {
    date: '2026-09-01',
    title: 'Um Novo Começo com Propósito',
    source_name: 'Lamentações 3:22-24',
    central_text: 'As misericórdias do Senhor são a causa de não sermos consumidos, porque as suas misericórdias não têm fim; renovam-se a cada manhã. Grande é a tua fidelidade!',
    context_text: 'Iniciamos um novo mês sob o manto da fidelidade de Deus. Não importa o que aconteceu nos meses anteriores; a cada amanhecer, Deus derrama uma porção fresca de misericórdia e perdão sobre as nossas vidas.\n\nEste é o momento de alinhar os seus projetos com a vontade soberana do Pai, crendo que Ele faz novas todas as coisas.',
    prayer_indication: 'Deus de alianças, agradeço por este novo mês que se inicia. Consagro a Ti cada plano, cada decisão e cada família da nossa igreja. Que a Tua fidelidade seja o nosso alicerce. Amém.',
    suggested_song: 'Fidelidade - Danielle Cristina',
    pastoral_comment: 'Setembro será um mês de colheita e portas abertas para quem caminha em obediência.'
  },
  {
    date: '2026-09-02',
    title: 'A Paz que Excede todo Entendimento',
    source_name: 'Filipenses 4:6-7',
    central_text: 'Não andeis ansiosos por coisa alguma; antes, em tudo, sejam os vossos pedidos conhecidos diante de Deus pela oração e súplica com ações de graças. E a paz de Deus, que excede todo o entendimento, guardará os vossos corações e as vossas mentes em Cristo Jesus.',
    context_text: 'A ansiedade tenta nos roubar o presente projetando medos no futuro. O apóstolo Paulo, mesmo preso em Roma, nos ensina o antídoto: transformar cada preocupação em oração e gratidão.\n\nA paz de Deus não é a ausência de problemas, mas a presença real de Cristo guardando nossa mente e nosso coração.',
    prayer_indication: 'Senhor Jesus, entrego a Ti todos os pensamentos de angústia. Derrama sobre a minha mente a Tua paz celestial que acalma as tempestades. Guardo meu coração na Tua presença. Amém.',
    suggested_song: 'A Paz Que Eu Preciso - Paulo César Baruk',
    pastoral_comment: 'Troque a preocupação pela oração de gratidão e veja a paz inundar a sua casa.'
  },
  {
    date: '2026-09-03',
    title: 'Permanecendo na Videira Verdadeira',
    source_name: 'João 15:4-5',
    central_text: 'Permaneçam em mim, e eu permanecerei em vocês. Nenhum ramo pode dar fruto por si mesmo, se não permanecer na videira. Vocês também não podem dar fruto, se não permanecerem em mim.',
    context_text: 'O segredo de uma vida cristã frutífera não é o esforço religioso, mas a comunhão íntima e constante com Jesus. O ramo não se esforça para produzir uvas; ele simplesmente absorve a seiva da videira.\n\nQuando priorizamos nosso tempo devocional, a oração e a Palavra, os frutos do Espírito Santo naturalmente transbordam em nossas atitudes.',
    prayer_indication: 'Jesus, Tu és a minha Videira. Quero permanecer enraizado em Ti todos os dias. Que a Tua vida flua através de mim para abençoar os que estão ao meu redor. Amém.',
    suggested_song: 'Lugar Secreto - Gabriela Rocha',
    pastoral_comment: 'A sua intimidade com Deus no secreto determinará a sua autoridade em público.'
  },
  {
    date: '2026-09-04',
    title: 'A Promessa do Cuidado Divino',
    source_name: 'Romanos 8:28',
    central_text: 'Sabemos que todas as coisas cooperam para o bem daqueles que amam a Deus, daqueles que são chamados segundo o seu propósito.',
    context_text: 'O texto não diz que todas as coisas são boas, mas que Deus tem o poder de pegar até mesmo as dores, perdas e adversidades e fazê-las cooperar para o nosso crescimento e amadurecimento espiritual.\n\nSe você ama a Deus, nada na sua vida é por acaso. Cada detalhe está sendo esculpido pelas mãos do Criador.',
    prayer_indication: 'Pai Celestial, eu confio na Tua soberania. Mesmo quando não compreendo os caminhos, sei que o Teu propósito é perfeito. Faz cooperar para o meu bem cada circunstância deste dia. Amém.',
    suggested_song: 'Todas as Coisas - Fernandinho',
    pastoral_comment: 'O que o inimigo intentou para o seu mal, Deus transformará em testemunho de vitória.'
  },
  {
    date: '2026-09-05',
    title: 'O Poder da Fé em Meio à Tempestade',
    source_name: 'Marcos 4:39-40',
    central_text: 'E Ele, levantando-se, repreendeu o vento e disse ao mar: Aquieta-te, emudece! O vento cessou, e houve grande bonança. E disse-lhes: Por que sois tão tímidos? Ainda não tendes fé?',
    context_text: 'Os discípulos estavam no mesmo barco que Jesus, mas quando o vento forte soprou, o pavor tomou conta de seus corações. Eles esqueceram de quem estava a bordo.\n\nQuando Jesus está no controle do seu barco, o naufrágio não é uma opção. Uma palavra dEle é suficiente para silenciar qualquer vendaval que queira desestruturar a sua vida.',
    prayer_indication: 'Senhor Jesus, repreende os ventos de desespero e medo que tentam abalar a minha família. Eu declaro que Tu estás no comando do meu barco e que a Tua bonança reinará. Amém.',
    suggested_song: 'Acalma o Meu Coração - Anderson Freire',
    pastoral_comment: 'A sua tempestade não é maior do que a autoridade do Senhor que habita em você.'
  },
  {
    date: '2026-09-06',
    title: 'Buscando o Reino em Primeiro Lugar',
    source_name: 'Mateus 6:33-34',
    central_text: 'Buscai, pois, em primeiro lugar, o seu reino e a sua justiça, e todas estas coisas vos serão acrescentadas.',
    context_text: 'A sociedade moderna nos ensina a correr atrás de posses, status e garantias terrenas. Mas o princípio do Reino de Deus funciona de forma inversa: quando colocamos a vontade do Rei no centro das nossas prioridades, o Pai celestial se encarrega de suprir cada uma de nossas necessidades.\n\nColoque Deus em primeiro lugar nas suas finanças, no seu casamento, no seu trabalho e veja as bênçãos sendo acrescentadas.',
    prayer_indication: 'Senhor, realinho as minhas prioridades hoje. Que o Teu Reino seja a minha maior paixão. Confio que o sustento e o cuidado virão das Tuas mãos generosas. Amém.',
    suggested_song: 'Primeiro Reino - Ministério Zoe',
    pastoral_comment: 'Quando Deus é o primeiro em tudo, Ele se responsabiliza pelo resto.'
  },
  {
    date: '2026-09-07',
    title: 'Coragem para Avançar na Promessa',
    source_name: 'Josué 1:9',
    central_text: 'Não fui eu que lhe ordenei? Seja forte e corajoso! Não se apavore nem desanime, pois o Senhor, o seu Deus, estará com você por onde você andar.',
    context_text: 'Josué assumiu a liderança de uma nação inteira após a morte de Moisés. O desafio era gigantesco, mas a garantia que ele recebeu não foi baseada em suas habilidades humanas, mas na presença contínua de Deus.\n\nA verdadeira coragem não é a ausência de medo, mas a decisão de avançar sabendo que o Senhor vai à nossa frente.',
    prayer_indication: 'Pai Todo-Poderoso, expulsa todo espírito de covardia e desânimo. Dá-me ousadia para conquistar os territórios espirituais e profissionais que Tu preparaste para mim. Amém.',
    suggested_song: 'Sê Forte e Corajoso - Diante do Trono',
    pastoral_comment: 'Deus não te chamou para recuar. Dê o próximo passo com fé e convicção.'
  },
  {
    date: '2026-09-08',
    title: 'O Refúgio Inabalável do Altíssimo',
    source_name: 'Salmos 91:1-2',
    central_text: 'Aquele que habita no esconderijo do Altíssimo, à sombra do Onipotente descansará. Direi do Senhor: Ele é o meu refúgio e a minha fortaleza, o meu Deus, em quem confio.',
    context_text: 'Habitar no esconderijo significa fazer da presença de Deus a nossa moradia diária, e não apenas um refúgio esporádico nos momentos de aperto. Na sombra do Todo-Poderoso, nenhum dardo inflamado do inimigo pode nos atingir fatalmente.\n\nEncontre hoje o seu descanso debaixo das asas protetoras do Criador.',
    prayer_indication: 'Senhor Deus, Tu és o meu castelo forte. Protege a minha mente, o meu corpo e os meus entes queridos de todo laço e perigo invisível. Eu descanso na Tua sombra. Amém.',
    suggested_song: 'Escudo - Voz da Verdade',
    pastoral_comment: 'Nenhum mal prevalecerá contra quem está escondido em Deus.'
  },
  {
    date: '2026-09-09',
    title: 'A Graça que nos Basta',
    source_name: '2 Coríntios 12:9',
    central_text: 'Mas ele me disse: A minha graça te basta, porque o meu poder se aperfeiçoa na fraqueza. De boa vontade, pois, me gloriarei nas minhas fraquezas, para que em mim habite o poder de Cristo.',
    context_text: 'Todos nós temos fragilidades e espinhos que nos lembram da nossa dependência de Deus. Paulo orou três vezes para que o espinho fosse removido, mas a resposta de Deus foi sublime: a graça dEle é mais do que suficiente para suportar e vencer.\n\nQuando reconhecemos nossa pequenez, abrimos espaço para o poder infinito de Cristo agir em nós.',
    prayer_indication: 'Senhor, obrigado porque a Tua graça não depende do meu merecimento. Que nas minhas limitações o Teu poder seja glorificado. Eu me rendo à Tua soberania. Amém.',
    suggested_song: 'Graça - Eli Soares',
    pastoral_comment: 'A graça de Deus não te livra apenas da dor, ela te capacita a triunfar através dela.'
  },
  {
    date: '2026-09-10',
    title: 'Planos de Paz e Esperança',
    source_name: 'Jeremias 29:11',
    central_text: 'Porque sou eu que conheço os planos que tenho para vocês, diz o Senhor, planos de fazê-los prosperar e não de causar dano, planos de dar a vocês esperança e um futuro.',
    context_text: 'Mesmo quando o povo de Israel estava no cativeiro babilônico, Deus enviou esta mensagem profética de esperança. Os planos de Deus para você não são de destruição, mas de redenção e plenitude.\n\nSe o seu presente parece confuso, lembre-se de que o Autor da sua história já escreveu o capítulo final com vitória.',
    prayer_indication: 'Pai, eu descanso o meu futuro em Tuas mãos. Sei que os Teus pensamentos a meu respeito são mais altos que os meus. Enche o meu coração de santa expectativa. Amém.',
    suggested_song: 'Deus dos Deuses - Lauriete',
    pastoral_comment: 'O seu futuro está guardado pelo Deus que nunca falhou.'
  },
  {
    date: '2026-09-11',
    title: 'O Fruto do Amor Prático',
    source_name: '1 João 4:18-19',
    central_text: 'No amor não há medo; ao contrário o perfeito amor expulsa o medo. Nós amamos porque ele nos amou primeiro.',
    context_text: 'O amor de Deus não é um conceito abstrato, mas uma força transformadora que dissipa toda insegurança, rejeição e temor. Fomos amados incondicionalmente no Calvário.\n\nQuando recebemos esse amor de forma profunda, somos capacitados a perdoar, acolher e amar até mesmo os mais difíceis.',
    prayer_indication: 'Senhor, inunda o meu ser com o Teu amor perfeito. Que todo medo do julgamento ou do futuro seja banido. Faz de mim um canal de compaixão e graça para o meu próximo. Amém.',
    suggested_song: 'Que Amor É Esse - Luma Elpidio',
    pastoral_comment: 'O amor é a maior arma espiritual que a Igreja possui. Ame sem reservas hoje.'
  },
  {
    date: '2026-09-12',
    title: 'Sabedoria do Alto para Decidir',
    source_name: 'Tiago 1:5-6',
    central_text: 'Se algum de vocês tem falta de sabedoria, peça-a a Deus, que a todos dá livremente, de boa vontade; e lhe será concedida. Peça-a, porém, com fé, em nada duvidando.',
    context_text: 'A inteligência humana analisa dados, mas a sabedoria divina discerne propósitos eternos. Em tempos de encruzilhadas e decisões cruciais, Deus se coloca à disposição para guiar os nossos pensamentos com discernimento celestial.\n\nAntes de tomar qualquer decisão hoje, consulte o Criador em oração.',
    prayer_indication: 'Senhor da Glória, clamo por sabedoria dos céus para os meus negócios, família e ministério. Não quero andar pelo meu próprio entendimento, mas pela Tua luz. Amém.',
    suggested_song: 'Vem Me Buscar - Jefferson & Suellen',
    pastoral_comment: 'Uma decisão tomada debaixo de oração poupa anos de arrependimento.'
  },
  {
    date: '2026-09-13',
    title: 'Alegria do Senhor: Nossa Fortaleza',
    source_name: 'Neemias 8:10',
    central_text: 'Não vos entristeçais, porque a alegria do Senhor é a vossa força.',
    context_text: 'A alegria cristã não depende de circunstâncias favoráveis, mas da certeza da salvação e da presença contínua do Espírito Santo. Quando os muros de Jerusalém estavam sendo reconstruídos, Neemias ensinou que a alegria em Deus é o combustível para superar os cansaços da obra.\n\nSorria hoje na presença de Deus; Ele é a sua fonte inesgotável de regozijo.',
    prayer_indication: 'Senhor Jesus, enche o meu coração da verdadeira alegria que o mundo não pode tirar. Que o meu testemunho reflita o Teu gozo mesmo nos dias mais desafiadores. Amém.',
    suggested_song: 'Todavia Me Alegrarei - Samuel Messias',
    pastoral_comment: 'A alegria do Senhor desarma qualquer ataque de desânimo do inimigo.'
  },
  {
    date: '2026-09-14',
    title: 'Além do que Pedimos ou Pensamos',
    source_name: 'Efésios 3:20-21',
    central_text: 'Àquele que é capaz de fazer infinitamente mais do que tudo o que pedimos ou pensamos, de acordo com o seu poder que atua em nós, a ele seja a glória na igreja e em Cristo Jesus.',
    context_text: 'A nossa imaginação tem limites, mas o poder de Deus não conhece barreiras. Muitas vezes limitamos o agir de Deus pelo tamanho da nossa pouca fé. Paulo nos desafia a crer que Deus tem reservado dimensões espirituais e milagres que superam as nossas maiores expectativas.\n\nAmplie a sua tenda espiritual e prepare-se para o sobrenatural.',
    prayer_indication: 'Deus Todo-Poderoso, liberta a minha mente de limitações carnais. Eu creio no Teu poder sobrenatural que opera em mim. Realiza além do que tenho ousado sonhar. Amém.',
    suggested_song: 'Grandes Coisas - Fernandinho',
    pastoral_comment: 'O tamanho do seu Deus determina o tamanho da sua vitória.'
  },
  {
    date: '2026-09-15',
    title: 'Lâmpada para os Meus Pés',
    source_name: 'Salmos 119:105',
    central_text: 'Lâmpada para os meus pés é tua palavra, e luz para o meu caminho.',
    context_text: 'Na antiguidade, as lamparinas iluminavam apenas o passo seguinte na escuridão, exigindo que o viajante andasse passo a passo dependente da luz. A Bíblia Sagrada é essa bússola viva que nos protege dos tropeços e nos conduz pelo caminho da verdade.\n\nFaça da leitura diária das Escrituras o seu alimento primordial.',
    prayer_indication: 'Senhor, abre os meus olhos para ver as maravilhas da Tua Lei. Que a Tua Palavra seja a verdade que molda as minhas escolhas e o rumo da minha vida. Amém.',
    suggested_song: 'A Palavra - Paulo César Baruk',
    pastoral_comment: 'Quem constrói a vida sobre a Rocha da Palavra jamais desaba nas tempestades.'
  },
  {
    date: '2026-09-16',
    title: 'Vencendo as Tentações com Oração',
    source_name: 'Mateus 26:41',
    central_text: 'Vigiem e orem para que não caiam em tentação. O espírito está pronto, mas a carne é fraca.',
    context_text: 'Jesus no Getsêmani nos alertou sobre a batalha interior entre a nossa nova natureza espiritual e os impulsos da carne. A vigilância e a oração contínua são os escudos que blindam as nossas emoções e guardam a nossa integridade moral.\n\nNão brinque com o pecado; fuja das aparências do mal e busque a santidade que honra a Deus.',
    prayer_indication: 'Senhor, sonda o meu coração e livra-me de toda armadilha oculta. Dá-me discernimento e força espiritual para resistir às tentações e honrar o Teu Santo Nome. Amém.',
    suggested_song: 'Em Fervente Oração - Harpa Cristã',
    pastoral_comment: 'A vigilância protege as portas da sua alma para que a glória de Deus habite em você.'
  },
  {
    date: '2026-09-17',
    title: 'O Poder do Perdão que Liberta',
    source_name: 'Colossenses 3:13',
    central_text: 'Suportem-se uns aos outros e perdoem as queixas que tiverem uns contra os outros. Perdoem como o Senhor lhes perdoou.',
    context_text: 'O ressentimento é um veneno que a pessoa ingere esperando que o outro sofra. O perdão não é um sentimento, mas uma decisão de obedecer a Cristo, que nos perdoou uma dívida impagável na cruz.\n\nLiberar perdão não significa concordar com o erro alheio, mas abrir a cela e descobrir que o verdadeiro prisioneiro era você.',
    prayer_indication: 'Pai, liberto todo ressentimento e mágoa do meu coração. Assim como fui alcançado pela Tua infinita misericórdia, decido perdoar a quem me ofendeu. Sara a minha alma. Amém.',
    suggested_song: 'Cicatrizes - Bruna Karla',
    pastoral_comment: 'O perdão é a chave que destranca o fluxo de cura e prosperidade espiritual na sua vida.'
  },
  {
    date: '2026-09-18',
    title: 'Vestindo a Armadura de Deus',
    source_name: 'Efésios 6:10-11',
    central_text: 'Finalmente, fortaleçam-se no Senhor e no seu forte poder. Vistam toda a armadura de Deus, para poderem ficar firmes contra as ciladas do diabo.',
    context_text: 'A nossa luta não é contra pessoas de carne e sangue, mas contra hostes espirituais da maldade. Deus nos equipou com o cinto da verdade, a couraça da justiça, o calçado do evangelho da paz, o escudo da fé, o capacete da salvação e a espada do Espírito, que é a Palavra de Deus.\n\nNão vá para a batalha desarmado; revista-se de autoridade espiritual.',
    prayer_indication: 'Senhor dos Exércitos, eu me revisto da Tua armadura celestial neste dia. Levanto o escudo da fé contra todas as setas malignas e declaro a vitória pelo sangue de Jesus. Amém.',
    suggested_song: 'Armadura de Deus - Ministério Sarando a Terra Ferida',
    pastoral_comment: 'Você é mais do que vencedor por meio dAquele que nos amou.'
  },
  {
    date: '2026-09-19',
    title: 'Comunhão e Crescimento em Célula',
    source_name: 'Atos 2:46-47',
    central_text: 'Todos os dias, continuavam a reunir-se no pátio do templo. Partiam o pão em suas casas e juntos participavam das refeições, com alegria e sinceridade de coração, louvando a Deus e tendo a simpatia de todo o povo.',
    context_text: 'A igreja primitiva crescia com poder porque vivia a fé nos grandes ajuntamentos e nas casas, de mesa em mesa. A comunhão cristã nos pequenos grupos gera suporte mútuo, oração intercessória e discipulado genuíno.\n\nNinguém foi chamado para viver a fé isolado. Conecte-se com sua célula e compartilhe a vida.',
    prayer_indication: 'Senhor, abençoa a nossa comunidade de fé e os nossos grupos de célula. Que haja unidade, amor fraterno e vidas sendo alcançadas pelo Evangelho em cada lar. Amém.',
    suggested_song: 'A Casa É Sua - Casa Worship',
    pastoral_comment: 'Família espiritual é o refúgio onde o amor de Deus se torna visível e palpável.'
  },
  {
    date: '2026-09-20',
    title: 'A Generosidade que Transborda',
    source_name: '2 Coríntios 9:7-8',
    central_text: 'Cada um dê conforme determinou em seu coração, não com pesar ou por obrigação, pois Deus ama quem dá com alegria. E Deus é poderoso para fazer que toda a graça lhes seja acrescentada.',
    context_text: 'A generosidade no Reino de Deus não é medida pelo valor monetário, mas pela intenção pura do coração. Quando ofertamos com alegria e servimos com voluntariedade, refletimos o caráter do Deus que nos deu Seu único Filho.\n\nA semeadura na obra de Deus sempre produz colheita de justiça e provisão abundante.',
    prayer_indication: 'Senhor generoso, consagro a Ti os meus talentos, recursos e tempo. Livra-me do apego material e faz-me um semeador alegre do Teu Reino. Amém.',
    suggested_song: 'Oferta Agradável a Ti - Cassiane',
    pastoral_comment: 'Mãos abertas para abençoar são mãos sempre prontas para receber do Pai.'
  },
  {
    date: '2026-09-21',
    title: 'Esperança Viva na Ressurreição',
    source_name: '1 Pedro 1:3-4',
    central_text: 'Bendito seja o Deus e Pai de nosso Senhor Jesus Cristo! Conforme a sua grande misericórdia, ele nos regenerou para uma esperança viva, por meio da ressurreição de Jesus Cristo dentre os mortos.',
    context_text: 'A nossa fé não está ancorada em fábulas ou filosofias terrenas, mas no túmulo vazio de Cristo. Por Ele estar vivo, a nossa esperança é viva, inquebrável e eterna.\n\nO mesmo poder do Espírito que ressuscitou a Jesus dentre os mortos habita em você para vivificar o que parecia morto.',
    prayer_indication: 'Jesus Vivo e Glorificado, agradeço pelo dom da vida eterna e pelo perdão dos meus pecados. Ressuscita em mim os sonhos e a esperança que se apagaram. Tu reinas para sempre! Amém.',
    suggested_song: 'Porque Ele Vive - Fernandinho',
    pastoral_comment: 'O túmulo está vazio, e por isso a sua vitória é certa.'
  },
  {
    date: '2026-09-22',
    title: 'Transformados pela Renovação da Mente',
    source_name: 'Romanos 12:2',
    central_text: 'Não se amoldem ao padrão deste mundo, mas transformem-se pela renovação da sua mente, para que sejam capazes de experimentar e comprovar a boa, agradável e perfeita vontade de Deus.',
    context_text: 'O mundo tenta nos moldar através de suas ideologias, apelos consumistas e padrões vazios. A verdadeira libertação começa na renovação dos nossos pensamentos através da meditação na Palavra de Deus.\n\nQuando alinhamos nossa mentalidade com o Céu, descobrimos a vontade perfeita do Pai para a nossa história.',
    prayer_indication: 'Espírito Santo, lava a minha mente com a verdade bíblica. Desfaço todo padrão mundano e acolho os Teus pensamentos de justiça, pureza e graça. Amém.',
    suggested_song: 'Renova-me - Marcos Góes',
    pastoral_comment: 'Mude a sua maneira de pensar e Deus mudará a sua maneira de viver.'
  },
  {
    date: '2026-09-23',
    title: 'A Fidelidade nos Pequenos Detalhes',
    source_name: 'Lucas 16:10',
    central_text: 'Quem é fiel no pouco, também é fiel no muito, e quem é desonesto no pouco, também é desonesto no muito.',
    context_text: 'Deus muitas vezes nos testa nas tarefas anônimas e nas responsabilidades cotidianas antes de nos confiar grandes plataformas e ministérios de impacto. A integridade que ninguém vê constrói a autoridade que todos respeitam.\n\nSeja excelente e honre a Deus onde você está hoje, pois Ele contempla o seu trabalho secreto.',
    prayer_indication: 'Senhor, ajuda-me a ser fiel nas pequenas tarefas, na administração do meu lar e na minha conduta diária. Que o meu testemunho glorifique a Ti em todo tempo. Amém.',
    suggested_song: 'Fidelidade - Danielle Cristina',
    pastoral_comment: 'Grandes palácios espirituais são construídos tijolo por tijolo na fidelidade do dia a dia.'
  },
  {
    date: '2026-09-24',
    title: 'Consolo Eterno nos Momentos de Aflição',
    source_name: '2 Coríntios 1:3-4',
    central_text: 'Bendito seja o Deus e Pai de nosso Senhor Jesus Cristo, Pai das misericórdias e Deus de toda consolação, que nos consola em todas as nossas tribulações, para que, com a consolação que recebemos de Deus, possamos consolar os que estão passando por tribulações.',
    context_text: 'Deus nunca desperdiça uma lágrima. O consolo que Ele derrama sobre nós nas noites escuras da alma nos prepara para sermos agentes de cura e abraço para os que estão sofrendo.\n\nA sua dor de hoje se tornará a mensagem de esperança que libertará outros amanhã.',
    prayer_indication: 'Pai de amor e misericórdia, consola o meu coração e enxuga as minhas lágrimas. Usa a minha história para levar alívio e compaixão àqueles que estão aflitos ao meu redor. Amém.',
    suggested_song: 'Consolador - Damares',
    pastoral_comment: 'O Espírito Santo é o seu Consolador presente. Você nunca está desamparado.'
  },
  {
    date: '2026-09-25',
    title: 'Oração sem Cessar',
    source_name: '1 Tessalonicenses 5:16-18',
    central_text: 'Alegrem-se sempre. Orem continuamente. Dêem graças em todas as circunstâncias, pois esta é a vontade de Deus para vocês em Cristo Jesus.',
    context_text: 'Orar continuamente não significa ficar o dia todo de joelhos em um quarto, mas manter uma atmosfera de diálogo permanente com Deus durante todas as atividades do dia.\n\nQuando transformamos nossa rotina em adoração e gratidão, o fardo fica leve e a presença de Deus se torna palpável.',
    prayer_indication: 'Senhor, quero manter a minha mente sintonizada Contigo em cada conversa, reunião e afazer. Obrigado por tudo o que já fizeste e pelo que ainda farás. Amém.',
    suggested_song: 'Em Espírito, Em Verdade - Kleber Lucas',
    pastoral_comment: 'A oração é a respiração do cristão. Mantenha os seus pulmões espirituais ativos.'
  },
  {
    date: '2026-09-26',
    title: 'A Humildade que Atrai a Glória',
    source_name: '1 Pedro 5:6-7',
    central_text: 'Humilhai-vos, pois, debaixo da potente mão de Deus, para que a seu tempo vos exalte, lançando sobre ele toda a vossa ansiedade, porque ele tem cuidado de vós.',
    context_text: 'A soberba afasta a graça, mas a humildade atrai o favor de Deus. Reconhecer que não temos o controle absoluto de tudo é o primeiro passo para a verdadeira paz.\n\nLance sobre o Senhor as suas preocupações financeiras, familiares e de saúde; Ele tem um zelo minucioso por cada detalhe da sua vida.',
    prayer_indication: 'Pai querido, dobro o meu orgulho diante da Tua majestade. Lanço aos Teus pés os meus fardos pesados. Confio no Teu cuidado e no Teu tempo perfeito para exaltar. Amém.',
    suggested_song: 'Humildade - Davi Sacer',
    pastoral_comment: 'Quem se humilha diante de Deus fica de pé diante de qualquer gigante.'
  },
  {
    date: '2026-09-27',
    title: 'Semeando no Espírito para a Vida Eterna',
    source_name: 'Gálatas 6:8-9',
    central_text: 'Quem semeia para a sua carne, da carne colherá destruição; mas quem semeia para o Espírito, do Espírito colherá a vida eterna. E não nos cansemos de fazer o bem, pois no tempo próprio colheremos, se não desanimarmos.',
    context_text: 'A vida espiritual é regida pela lei da semeadura e da colheita. Cada palavra de encorajamento, cada oração intercessória, cada ato de generosidade é uma semente lançada em solo fértil.\n\nMuitas vezes o tempo entre semear e colher exige paciência, mas a promessa de Deus é infalível: a colheita virá no tempo certo.',
    prayer_indication: 'Senhor, não permitas que o cansaço me faça parar de semear o bem e o Teu amor. Fortalece o meu espírito para que eu colha frutos de justiça e vida eterna. Amém.',
    suggested_song: 'A Colheita - Alda Célia',
    pastoral_comment: 'A semente lançada com lágrimas de fé voltará como feixes de grande júbilo.'
  },
  {
    date: '2026-09-28',
    title: 'Mais que Vencedores em Cristo',
    source_name: 'Romanos 8:37-39',
    central_text: 'Mas em todas estas coisas somos mais que vencedores, por meio daquele que nos amou. Pois estou convencido de que nem morte nem vida, nem anjos nem demônios, nem o presente nem o futuro (...) poderá nos separar do amor de Deus.',
    context_text: 'Ser mais que vencedor significa que a vitória de Cristo na cruz já foi conquistada e creditada na nossa conta espiritual. Nenhuma tribulação, angústia, perseguição ou perigo pode anular a nossa identidade de filhos amados de Deus.\n\nCaminhe hoje com a cabeça erguida, pois o Rei do Universo caminha ao seu lado.',
    prayer_indication: 'Senhor Jesus, declaro que nada pode me separar do Teu amor incondicional. Eu me aproprio da Tua vitória na cruz e tomo posse da paz e da autoridade que me deste. Amém.',
    suggested_song: 'Mais Que Vencedor - Thalles Roberto',
    pastoral_comment: 'Você não luta PARA vencer, você luta A PARTIR da vitória que Cristo já garantiu.'
  },
  {
    date: '2026-09-29',
    title: 'A Luz que Resplandece nas Trevas',
    source_name: 'Mateus 5:14-16',
    central_text: 'Vocês são a luz do mundo. Não se pode esconder uma cidade construída sobre um monte. (...) Assim brilhe a luz de vocês diante dos homens, para que vejam as suas boas obras e glorifiquem ao Pai de vocês, que está nos céus.',
    context_text: 'A Igreja não foi chamada para se esconder, mas para ser referência de retidão, amor e esperança em uma sociedade em trevas. A sua conduta no trabalho, o seu respeito na família e o seu testemunho diário são os reflexos da luz de Cristo.\n\nDeixe o brilho de Jesus iluminar as pessoas ao seu redor através das suas atitudes.',
    prayer_indication: 'Senhor Deus, faz-me resplandecer a Tua luz por onde eu passar. Que as minhas palavras e ações apontem sempre para a glória do Teu Nome. Amém.',
    suggested_song: 'Luz do Mundo - Ministério Zoe',
    pastoral_comment: 'Quanto mais escuro o ambiente, mais brilhante se torna a luz de um cristão autêntico.'
  },
  {
    date: '2026-09-30',
    title: 'Fechando o Mês com Coração Grato',
    source_name: 'Salmos 103:1-5',
    central_text: 'Bendize, ó minha alma, ao Senhor, e tudo o que há em mim bendiga o seu santo nome. Bendize, ó minha alma, ao Senhor, e não te esqueças de nenhum de seus benefícios. É ele que perdoa todas as tuas iniquidades e sara todas as tuas enfermidades.',
    context_text: 'Encerramos este mês com um memorial de gratidão no coração. Lembrar os benefícios do Senhor é uma poderosa arma espiritual contra o desânimo e a ingratidão. Ele nos sustentou, perdoou nossas falhas, curou nossas dores e corou as nossas vidas de graça e misericórdia.\n\nCelebre cada vitória e entre no próximo ciclo com fé renovada!',
    prayer_indication: 'Senhor, a minha alma Te louva por cada dia deste mês. Obrigado pelo pão de cada dia, pela proteção aos meus filhos e pela comunhão da igreja. A Ti toda a honra, glória e louvor para sempre. Amém!',
    suggested_song: 'A Bênção - Gabriel Guedes e Julia Vitória',
    pastoral_comment: 'Gratidão pelo passado abre as comportas das bênçãos para o futuro. Você é abençoado!'
  }
];

async function insertAllDevotionals() {
  console.log(`\n======================================================`);
  console.log(`   INSERINDO 32 DEVOCIONAIS DIÁRIOS (30/AGO A 30/SET) `);
  console.log(`   ORGANIZAÇÃO: Igreja Viva (org_default)            `);
  console.log(`======================================================\n`);

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'faith-hub.cc7220s4ekvj.us-east-1.rds.amazonaws.com',
    user: process.env.DB_USER || 'admin_faith_hub',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  try {
    let inserted = 0;
    let updated = 0;

    for (const d of devotionalsData) {
      // Check if devotional for date and org already exists
      const [existing] = await connection.query(
        `SELECT id FROM devotionals WHERE available_date = ? AND organization_id = 'org_default'`,
        [d.date]
      );

      if (existing.length > 0) {
        const id = existing[0].id;
        await connection.query(
          `UPDATE devotionals 
           SET title = ?, source_type = 'BIBLE', source_name = ?, suggested_song_title = ?,
               central_text = ?, context_text = ?, prayer_indication = ?, pastoral_author_name = 'Pr. Rafael Sena',
               pastoral_author_role = 'Pastor Titular', pastoral_comment = ?, status = 'PUBLISHED', updated_at = NOW()
           WHERE id = ?`,
          [
            d.title, d.source_name, d.suggested_song,
            d.central_text, d.context_text, d.prayer_indication,
            d.pastoral_comment, id
          ]
        );
        updated++;
        console.log(`✓ [UPDATE] ${d.date} - ${d.title} (${d.source_name})`);
      } else {
        const id = uuidv4();
        await connection.query(
          `INSERT INTO devotionals (
            id, available_date, title, source_type, source_name, suggested_song_title,
            central_text, context_text, prayer_indication, pastoral_author_name,
            pastoral_author_role, pastoral_comment, status, organization_id, campus_id, created_at, updated_at
          ) VALUES (?, ?, ?, 'BIBLE', ?, ?, ?, ?, ?, 'Pr. Rafael Sena', 'Pastor Titular', ?, 'PUBLISHED', 'org_default', NULL, NOW(), NOW())`,
          [
            id, d.date, d.title, d.source_name, d.suggested_song,
            d.central_text, d.context_text, d.prayer_indication,
            d.pastoral_comment
          ]
        );
        inserted++;
        console.log(`+ [INSERT] ${d.date} - ${d.title} (${d.source_name})`);
      }
    }

    console.log(`\n======================================================`);
    console.log(`✓ SUCESSO! Total processado: ${devotionalsData.length} | Inseridos: ${inserted} | Atualizados: ${updated}`);
    console.log(`======================================================\n`);

  } catch (err) {
    console.error('Erro na inserção de devocionais:', err);
  } finally {
    await connection.end();
  }
}

insertAllDevotionals();
