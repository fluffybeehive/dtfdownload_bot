const { MongoClient } = require('mongodb');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios')

class App {
	constructor() {
		// mongodb uri
		this.mongoUri = 'mongodb://';
		// mongodb database name
		this.mongoDbName = '';
		// mongodb collection name 
		this.mongoCollectionName = '';

		this.usersRateLimits = {};
		this.usersRandomEntry = {};

		// User timeout between requests
		this.rateLimit = 1000;
		this.lastApiRequest = 0;
		// DTF timeout between requests
		this.apiRateLimit = 350;

		this.telegramBotToken = '';
		this.telegramBot = new TelegramBot(this.telegramBotToken, {polling: true});
	}

	async start() {
		const uri = this.mongoUri;

	    this.client = new MongoClient(uri, {useUnifiedTopology: true});
	    await this.client.connect();

		console.log('Initialized db');

	    this.filesDb = this.client.db(this.mongoDbName).collection(this.mongoCollectionName);
	    this.telegramBot.on('message', this.botMessage.bind(this));
	}

	isUserRateLimited(id) {
		if (!this.usersRateLimits[id]) {
			this.usersRateLimits[id] = Date.now();
			return false;
		}
		const lastRequestTime = this.usersRateLimits[id];
		if (Date.now() - lastRequestTime < this.rateLimit) {
			return true;
		}
		this.usersRateLimits[id] = Date.now();
		return false;
	}

	async sendVideo(url, chatId, postId, caption, commentId) {
		const isCached = await this.filesDb.findOne({url: url});
		if (isCached) {
			await this.filesDb.updateOne({url: url}, {'$inc': {loads: 1}, '$set': {lastLoadTime: Date.now()}});
			if(isCached.type === 'animation') {
				return await this.telegramBot.sendAnimation(chatId, isCached.file.file_id, {caption: isCached.caption});
			}
			return await this.telegramBot.sendVideo(chatId, isCached.file.file_id, {caption: isCached.caption});
		}
		const response = await this.telegramBot.sendVideo(chatId, url, {caption: caption});
		const type = response.video ? 'video' : 'animation';
		await this.filesDb.insertOne({
			postId: postId,
			caption: caption,
			commentId: commentId,
			url: url,
			type: type,
			file: response.video ? response.video : response.animation,
			createdAt: Date.now(),
			lastLoadTime: Date.now(),
			loads: 1
		})
	}

	async sendRandomVideo(chatId) {
		const lastUserRandomEntry = this.usersRandomEntry[chatId] ? this.usersRandomEntry[chatId] : '';
		const entries = await (this.filesDb.find({url: {$ne: lastUserRandomEntry}})).toArray();
		const entry = entries[Math.floor(Math.random()*entries.length)];
		
		this.usersRandomEntry[chatId] = entry.url;
		
		await this.sendVideo(entry.url, chatId, entry.postId, entry.caption, entry.commentId);
	}

	async sleep(ms) {
		return new Promise((resolve) => {
			setTimeout(() => resolve(), ms);
		})
	}

	async apiRequest(url) {
		if(Date.now() - this.lastApiRequest < this.apiRateLimit) {
			const sleepTime = this.apiRateLimit - (Date.now() - this.lastApiRequest);
			console.log('Api rate limit, sleeping:', sleepTime, this.lastApiRequest);
			await this.sleep(sleepTime);
			return this.apiRequest(url);
		}
		this.lastApiRequest = Date.now();
		return (await axios.get(url)).data;
	}

	async botMessage(msg) {
		const chatId = msg.chat.id;
		const text = msg.text;

		try {
			if(text === '/random') {
				this.sendRandomVideo(chatId);
			} else if (text.match(/dtf\.ru(\/.*?)?\/(\d+).*?\?comment=(\d+)/)) {
				if (this.isUserRateLimited(chatId)) {
					console.log(chatId, 'User rate limited', this.usersRateLimits);
					return false;
				}

				let urlInfo = text.match(/dtf\.ru(\/.*?)?\/(\d+).*?\?comment=(\d+)/);

				const postId = urlInfo[2];
				const commentId = parseInt(urlInfo[3]);
				const commentsData = await this.apiRequest('https://api.dtf.ru/v2.1/comments?contentId=' + postId);
				let comment = commentsData.result.items.filter((e) => e.id === commentId);
				if (!comment.length) {
					return false;
				}
				comment = comment[0];

				if (!comment.media.length) {
					return false;
				}

				const url = 'https://leonardo.osnova.io/' + comment.media[0].data.uuid + '/-/format/mp4/';
				await this.sendVideo(url, chatId, postId, comment.text, commentId);
			} else if (text.match(/dtf\.ru(\/.*?)?\/(\d+)/)) {
				if (this.isUserRateLimited(chatId)) {
					console.log(chatId, 'User rate limited', this.usersRateLimits);
					return false;
				}

				const postId = text.match(/dtf\.ru(\/.*?)?\/(\d+)/)[2];
				const postData = await this.apiRequest('https://api.dtf.ru/v2.1/content/?id=' + postId);
				const postHtml = postData.result.html.layout;
				const postTitle = postData.result.title;

				const mp4urls = postHtml.match(/data-video-mp4="(.*?)"/gm);
				for(let i = 0; i < mp4urls.length; i++) {
					const url = mp4urls[i].match(/data-video-mp4="(.*?)"/)[1];
					await this.sendVideo(url, chatId, postId, postTitle);
					await this.sleep(1000);
				}
			}
		} catch (e) {
			console.log('Error parsing message', e);
		}
	}
}

(new App()).start();