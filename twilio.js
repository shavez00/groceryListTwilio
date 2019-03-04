const http = require('http');
const express = require('express');
const MessagingResponse = require('twilio').twiml.MessagingResponse;
const bodyParser = require('body-parser');
const fs = require('fs');

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));

app.post('/sms/', (req, res) => {
  const body = req.body.Body;
  const twiml = new MessagingResponse();
  const response = body.toLowerCase();
  let command = '';

  //parse the request sent in by the user and look for the first word then set the
  //command varible that will used to determine the proper response later
  if (response.substring(0, 3) == "add") {
    command = 'add';
  }
  else if (response.substring(0, 4) == "list") {
    command = 'list';
  }
  else if (response.substring(0, 6) == 'remove') {
    command = 'remove';
  }

  //based upon the command sent by the user, the following will do certain
  //actions ex: list out items on the todo list
  switch (command) {
    case 'add':
      fs.appendFile('list.txt', body.substring(4) + ',');
      console.log('Saved!');
      twiml.message("Added");
      break;
    case 'list':
      //read todo list file and load it into varible as an array using the 
      //readList function
      var list = readList('./list.txt');

      //if list is currently empty tell the user
      if (list[0] == "undefined" || list[0] == '') {
        twiml.message("List is currently empty");
        fs.writeFileSync('list.txt', '');
      } else {
        let finalList = '';

        //iterate through list, add a row number to each item, and send it
        //to the user
        for (let i = 0; i < list.length - 1; i++) {
          finalList = finalList + "\n" + (i + 1) + ". " + list[i];
        }

        twiml.message({
          action: 'http://ec2-35-171-203-74.compute-1.amazonaws.com:8080/status/',
          method: 'POST'
        }, finalList);

        //clear varibles that were used so they can be reused clean
        list, finalList = '';
      }

      break;
    case 'remove':
      let itemToBeRemoved = body.substring(7);

      if (isNaN(itemToBeRemoved)) {
        twiml.message("Please send number of item to be removed.");
      }
      else {
        var newList = '';
        //read todo list file and load it into varible as an array using the 
        //readList function
        list = readList('./list.txt');

        if (itemToBeRemoved > list.length - 1 || itemToBeRemoved <= 0) {
          twiml.message("Please enter a number from 1 to " + (list.length - 1));
        }
        else {
          for (let i = 0; i < list.length - 1; i++) {
            if (itemToBeRemoved != i + 1) {
              newList = newList + list[i] + ",";
            }
          }
          twiml.message("Removed");
          fs.writeFileSync('list.txt', newList);
        }
      }

      console.log(newList);

      //clear varibles that were used so they can be reused clean
      list, newList = '';
      break;
    default:
      twiml.message("Please respond with add {item}, list, or remove {item}");
      break;
  }

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

app.post('/status/', (req, res) => {
  console.log("Message Status: " + req.body.MessageStatus);
});

http.createServer(app).listen(8080, () => {
  console.log('Express server listening on port 8080');
});

var readList = (listFile) => {
  return fs.readFileSync(listFile, 'utf8').split(',');
};