import _ from 'lodash'
import fileExtension from 'file-extension'
import fs from 'fs'
import moment from 'moment'
import path from 'path'
import rss from './data/rss.json'
import sharp from 'sharp'
import shell from 'shelljs'
import wget from 'node-wget-promise'
import wgetp from 'node-wget-promise'
import xml2js from 'xml2js'
import Util from './scripts/util'

let util = new Util()

const RFC822 = 'ddd, DD MMM YYYY HH:mm:ss ZZ'
const DOWNLOADS_DIR = 'static/downloads'
const RSS_DIR       = 'static/downloads/rss'
const COVER_DIR     = 'static/downloads/cover'
const BUILD_INFO    = 'static/downloads/build_info.json'

// Make sure parent dir existence and its clean
shell.rm('-rf', DOWNLOADS_DIR)
shell.mkdir('-p', RSS_DIR)
shell.mkdir('-p', COVER_DIR)

var latest_pubdates = []
var episodes_in_2weeks = []
var channels = {}
var covers = {}
var episodeCount = 0

process.on('unhandledRejection', console.dir)

const fetchFeed = async key => {
  const src = rss[key].feed
  const dist_rss = `${RSS_DIR}/${key}.rss`
  await wget(src, { output: dist_rss })
  .then( metadata => {
    // nodeから実行する場合に、importなどが使えなかったために、async/awaitなどを使わないやり方で書いている
    fs.readFile(`${__dirname}/${dist_rss}`, (err, xml)=> {
      if(err) {
        console.error(`[prebuild error] read | ${dist_rss}`)
        throw err
      }
      xml2js.parseString(xml, {explicitArray: false}, (_err, json)=> {

        if(_err) {
          console.error(`[prebuild error] parse | ${dist_rss}`)
          // throw _err // ここでエラーを発生させてしまうとビルドが継続しない
          return
        }

        // Get cover image urls
        const cover_url = util.removeQuery(_.get(json, 'rss.channel[itunes:image].$.href') || _.get(json, 'rss.channel[itunes:image].href') || _.get(json, 'rss.channel.image.url'))
        if(cover_url){
          covers[key] = {
            src: cover_url,
            dist: `${COVER_DIR}/${key}.${fileExtension(cover_url)}`
          }
        }

        // count episodes
        episodeCount += json.rss.channel.item.length

        // json.rss.channel.item がなくてエラーになることがあるのでここで間引く
        // TODO: ほんとに問題ない？
        // if(!_.has(json, 'rss.channel.item')){
        //   console.error('[prebuild error] json.rss.channel.item is undefined (key='+key+')')
        //   // throw new Error('[prebuild error] json.rss.channel.item is undefined (key='+key+')')
        // }

        // json.rss.channel.item must be Array
        if(!(json.rss.channel.item instanceof Array)) {
          json.rss.channel.item = [json.rss.channel.item]
          // TODO ページの描画時にも配列でないことで不具合が起こるので、ここで上書きしてしまいたい
        }

        // Get the latest episode's publish date
        latest_pubdates.push({
          id: key,
          pubDate: json.rss.channel.item[0].pubDate
        })

        // Store episodes in last 2 weeks
        const title = json.rss.channel.title
        const twoweeksago = moment().subtract(14, 'days').startOf('date')
        // RSS date format is RFC-822
        const episodes = json.rss.channel.item.filter((element, index, array)=> {
          return moment(element.pubDate, RFC822).isAfter(twoweeksago)
        })
        // Add channel info into each episodes
        episodes.forEach(function(el) {
          el['key'] = key
          el['channel_title'] = title
        })
        episodes_in_2weeks = episodes_in_2weeks.concat(episodes)

        // Save data
        channels[key] = {
          key,
          title,
          twitter: rss[key].twitter,
          feed: rss[key].feed,
          link: json.rss.channel.link,
          hashtag: rss[key].hashtag,
          cover: covers[key] ? covers[key].dist.replace(/^static/,'') : null,
          total: json.rss.channel.item.length,
          firstEpisodeDate: moment(_.last(json.rss.channel.item).pubDate, RFC822).format(moment.HTML5_FMT.DATETIME_LOCAL_SECONDS),
          lastEpisodeDate: moment(_.first(json.rss.channel.item).pubDate, RFC822).format(moment.HTML5_FMT.DATETIME_LOCAL_SECONDS),
          firstEpisodeLink: _.last(json.rss.channel.item).link,
          lastEpisodeLink: _.first(json.rss.channel.item).link,
          fileServer: util.getFileServer(json.rss.channel.item[0]),
          durationAverage: util.getDurationAverage(json.rss.channel.item, dist_rss),
          durationMedian: util.getDurationMedian(json.rss.channel.item, dist_rss),
          desciprtion: json.rss.channel.description
        }
      })
    })
    console.log('OK!', key)
  })
  .catch( err => {
    console.error('[prebuild error]', err, key)
  })
  console.log('done...')
}

(async () => {

  await Promise.all(Object.keys(rss).map(async key => await fetchFeed(key)))

  console.log('ALL DONE!!!!')

  // Export to list file ordered by pubDate
  latest_pubdates.sort(function(a, b) {
    return new Date(b.pubDate) - new Date(a.pubDate)
  })
  episodes_in_2weeks.sort(function(a, b) {
    return new Date(b.pubDate) - new Date(a.pubDate)
  })
  var load_order = latest_pubdates.map(function(element, index, array) {
    return element.id;
  });

  // Download cover images ONE BY ONE
  // 一気にwgetすると404になる場合があるのでひとつずつ順番に取得する
  const resolveAfter = (_key, _src, _dist) => {
    const config = {
      all: {
        quality: 100,
        path: `${COVER_DIR}/`
      },
      versions: [
        {
          suffix: '-30',
          width: 60,
          height: 60
        },
        {
          suffix: '-60',
          width: 120,
          height: 120
        }
      ]
    }
    return wgetp(_src, {output: _dist}).then(() => {
      const ext = path.extname(_dist)
      const ext_120 = _dist.replace(ext, ext.replace('.', '-120.'))
      const ext_60 = _dist.replace(ext, ext.replace('.', '-60.'))
      sharp(_dist)
        .resize(120)
        .toFile(ext_120, (err, info) => {
          if(err){
            console.error('[prebuild error]', err, info)
          }
        })
        .resize(60)
        .toFile(ext_60, (err, info) => {
          if(err){
            console.error('[prebuild error]', err, info)
          }
        })
    })
  }
  let p = Promise.resolve()
  Object.keys(covers).forEach(function (_key) {
    p = p.then(() => resolveAfter(_key, covers[_key].src, covers[_key].dist));
  })

  var data = {
    load_order,
    episodes_in_2weeks,
    channels,
    updated: new Date(),
    episodeCount
  }
  fs.writeFileSync(BUILD_INFO, JSON.stringify(data), 'utf8');
  console.log('FILE OK!')
})();

